import * as log from './util/logger.js'
import { getBackend } from './backends/index.js'
import { MOVIE_BATCH_SIZE, BACKEND } from './config.js'
import { WebSocket } from './util/websocketServer.js'
import { authenticateJellyfinUser } from './util/jellyfinUser.js'
import type { JellyfinSession } from './util/jellyfinUser.js'
import { syncPlaylist } from './util/jellyfinPlaylist.js'
import type { MediaItem } from './backends/types.js'
import {
  ensureRoom,
  getOrCreateUser,
  getRoomMedia,
  getRoomMediaGuids,
  addRoomMedia,
  recordSwipe,
  getUserSwipedGuids,
  getUserLikedGuids,
  getLikersForMedia,
  getRoomMatches,
  deleteLastSwipe,
  getRoomMatchGuids,
  getRoomParticipantNames,
} from './db/database.js'

interface Response {
  guid: string
  wantsToWatch: boolean
}

interface WebSocketLoginMessage {
  type: 'login'
  payload: {
    name: string
    roomCode: string
    password?: string
    createPlaylist?: boolean
  }
}

interface WebSocketMatchMessage {
  type: 'match'
  payload: {
    movie: MediaItem
    users: string[]
  }
}

interface WebSocketLoginResponseMessage {
  type: 'loginResponse'
  payload:
    | { success: false; reason?: string }
    | {
        success: true
        jellyfinAuthenticated: boolean
        playlistEnabled: boolean
        matches: Array<WebSocketMatchMessage['payload']>
        movies: MediaItem[]
      }
}

interface WebSocketResponseMessage {
  type: 'response'
  payload: Response
}

interface WebSocketNextBatchMessage {
  type: 'nextBatch'
}

interface WebSocketUndoMessage {
  type: 'undo'
}

type WebSocketMessage =
  | WebSocketLoginMessage
  | WebSocketResponseMessage
  | WebSocketNextBatchMessage
  | WebSocketUndoMessage

interface SessionUser {
  id: number
  name: string
}

class Session {
  roomCode: string
  userConnections: Map<number, WebSocket> = new Map()
  movieListCache: MediaItem[] = []
  matchGuids: Set<string> = new Set()
  playlistSyncTimers: Map<number, NodeJS.Timeout> = new Map()
  playlistSyncInProgress: Map<number, boolean> = new Map()

  constructor(roomCode: string) {
    this.roomCode = roomCode
    // Initialize matchGuids from database
    this.matchGuids = getRoomMatchGuids(roomCode)
  }

  addConnection = (userId: number, name: string, ws: WebSocket) => {
    this.userConnections.set(userId, ws)

    ws.addListener('message', msg => this.handleMessage(userId, name, msg))
    ws.addListener('close', () => this.removeConnection(userId, name))
  }

  removeConnection = (userId: number, name: string) => {
    log.debug(`User ${name} (id=${userId}) connection closed`)
    this.userConnections.delete(userId)

    // Clean up playlist sync timer for this user
    const timer = this.playlistSyncTimers.get(userId)
    if (timer) {
      clearTimeout(timer)
      this.playlistSyncTimers.delete(userId)
    }
    this.playlistSyncInProgress.delete(userId)

    if (this.userConnections.size === 0) {
      log.debug(
        `Session ${this.roomCode} has no active connections, removing from active sessions (data persists in database)`,
      )
      activeSessions.delete(this.roomCode)
    }
  }

  handleMessage = async (userId: number, name: string, msg: string) => {
    let decodedMessage: WebSocketMessage | undefined
    try {
      decodedMessage = JSON.parse(msg)
      if (
        !decodedMessage ||
        typeof decodedMessage !== 'object' ||
        !('type' in decodedMessage)
      ) {
        log.warning(`Invalid message structure (length: ${msg.length} bytes)`)
        return
      }
      switch (decodedMessage.type) {
        case 'nextBatch': {
          log.debug(`${name} asked for the next batch of movies`)
          await this.sendNextBatch(userId)
          break
        }
        case 'response': {
          const { guid, wantsToWatch } = decodedMessage.payload

          // Validate input types
          if (typeof guid !== 'string' || typeof wantsToWatch !== 'boolean') {
            log.warning('Response message has invalid types')
            return
          }

          // Validate guid belongs to this room
          if (!this.movieListCache.find(m => m.guid === guid)) {
            log.error(
              `${name} tried to rate a movie that doesn't exist in room: ${guid}`,
            )
            return
          }

          // Check if already swiped
          const userSwiped = getUserSwipedGuids(userId)
          if (userSwiped.has(guid)) {
            log.warning(
              `User ${name} tried to respond to ${guid} twice! Ignoring.`,
            )
            return
          }

          log.debug(
            `${name} ${
              wantsToWatch ? 'wants to watch' : 'does not want to watch'
            } ${guid}`,
          )

          const isNew = recordSwipe(userId, guid, wantsToWatch)
          if (!isNew) {
            log.warning(`Swipe not recorded (duplicate) for ${name} / ${guid}`)
            return
          }

          // Reconcile matches after the swipe
          this.reconcileMatches()
          break
        }
        case 'undo': {
          log.debug(`${name} is trying to undo their last swipe`)

          const result = deleteLastSwipe(userId)
          if (!result) {
            log.debug(`${name} has no swipes to undo`)
            const ws = this.userConnections.get(userId)
            if (ws && !ws.isClosed) {
              ws.send(
                JSON.stringify({
                  type: 'undoResponse',
                  payload: {
                    success: false,
                  },
                }),
              )
            }
            break
          }

          const { guid, wantsToWatch } = result
          log.debug(`Deleted swipe for ${name}: ${guid}`)

          // Reconcile matches after the undo
          this.reconcileMatches()

          // Send undoResponse to the requester
          const ws = this.userConnections.get(userId)
          if (ws && !ws.isClosed) {
            ws.send(
              JSON.stringify({
                type: 'undoResponse',
                payload: {
                  success: true,
                  guid,
                },
              }),
            )
          }
          break
        }
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        // Invalid JSON - log but don't crash
        // Only log message type and length to avoid exposing credentials
        log.warning(`Invalid JSON received (length: ${msg.length} bytes)`)
      } else {
        // Log error but not the raw message content
        log.error(
          `Error handling message (type: ${decodedMessage?.type ?? 'unknown'}, length: ${msg.length} bytes):`,
          err,
        )
      }
    }
  }

  async sendNextBatch(userId: number) {
    try {
      const backend = getBackend()
      const allMediaItems = await backend.getMediaItems()

      // Get already distributed guids
      const distributedGuids = getRoomMediaGuids(this.roomCode)

      // Filter to undistributed
      const candidates = allMediaItems.filter(
        item => !distributedGuids.has(item.guid),
      )

      if (candidates.length === 0) {
        // No more movies
        for (const ws of this.userConnections.values()) {
          if (!ws.isClosed) {
            ws.send(
              JSON.stringify({
                type: 'batch',
                payload: [],
              }),
            )
          }
        }
        return
      }

      // Pick random batch using partial Fisher-Yates shuffle (without modifying original array)
      const batchSize = Math.min(candidates.length, Number(MOVIE_BATCH_SIZE))
      const batch: MediaItem[] = []

      // Create a copy to avoid modifying the original array
      const candidatesCopy = [...candidates]

      for (let i = 0; i < batchSize; i++) {
        // Pick random index from [i, length)
        const j = i + Math.floor(Math.random() * (candidatesCopy.length - i))
        // Swap elements at i and j
        const temp = candidatesCopy[i]
        candidatesCopy[i] = candidatesCopy[j]
        candidatesCopy[j] = temp
        // Add the element at position i to the batch
        batch.push(candidatesCopy[i])
      }

      // Add to database and cache
      addRoomMedia(this.roomCode, batch)
      this.movieListCache.push(...batch)

      // Send to all users, filtering already-swiped
      for (const [connectedUserId, ws] of this.userConnections.entries()) {
        if (!ws.isClosed) {
          const userSwiped = getUserSwipedGuids(connectedUserId)
          const filteredBatch = batch.filter(
            movie => !userSwiped.has(movie.guid),
          )
          ws.send(
            JSON.stringify({
              type: 'batch',
              payload: filteredBatch,
            }),
          )
        }
      }
    } catch (err) {
      log.error('Error sending next batch:', err)
    }
  }

  broadcastMatch(movie: MediaItem, userNames: string[]) {
    for (const ws of this.userConnections.values()) {
      const match: WebSocketMatchMessage = {
        type: 'match',
        payload: {
          movie,
          users: userNames,
        },
      }

      if (!ws.isClosed) {
        ws.send(JSON.stringify(match))
      }
    }
  }

  reconcileMatches() {
    const newMatchGuids = getRoomMatchGuids(this.roomCode)

    // Find newly added matches
    for (const guid of newMatchGuids) {
      if (!this.matchGuids.has(guid)) {
        const movie = this.movieListCache.find(m => m.guid === guid)
        if (movie) {
          const userNames = getLikersForMedia(this.roomCode, guid)
          this.broadcastMatch(movie, userNames)
        }
      }
    }

    // Find removed matches
    for (const guid of this.matchGuids) {
      if (!newMatchGuids.has(guid)) {
        for (const ws of this.userConnections.values()) {
          if (!ws.isClosed) {
            ws.send(
              JSON.stringify({
                type: 'matchRemoved',
                payload: { guid },
              }),
            )
          }
        }
      }
    }

    // Update stored match guids
    this.matchGuids = newMatchGuids

    // Schedule playlist sync for all eligible connections
    this.schedulePlaylistSync()
  }

  private schedulePlaylistSync() {
    for (const [userId, ws] of this.userConnections.entries()) {
      if (ws.playlistEnabled && ws.jellyfin) {
        this.schedulePlaylistSyncForUser(userId, ws)
      }
    }
  }

  private schedulePlaylistSyncForUser(userId: number, ws: WebSocket) {
    // Cancel existing timer if any
    const existingTimer = this.playlistSyncTimers.get(userId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Schedule new sync after 3 seconds of inactivity
    const timer = setTimeout(() => {
      this.playlistSyncTimers.delete(userId)
      this.executePlaylistSync(userId, ws)
    }, 3000)

    // Use unref() to not keep the process alive just for this timer
    timer.unref()

    this.playlistSyncTimers.set(userId, timer)
  }

  private async executePlaylistSync(userId: number, ws: WebSocket) {
    // Prevent concurrent syncs for the same user
    if (this.playlistSyncInProgress.get(userId)) {
      return
    }

    if (!ws.jellyfin || !ws.playlistEnabled) {
      return
    }

    this.playlistSyncInProgress.set(userId, true)
    try {
      const matchGuids = Array.from(this.matchGuids).sort()
      const participantNames = getRoomParticipantNames(this.roomCode)
      const playlistName =
        participantNames.length > 0
          ? `${participantNames.join(', ')} – ${this.roomCode}`
          : this.roomCode

      const playlistId = await syncPlaylist({
        session: ws.jellyfin,
        playlistName,
        itemIds: matchGuids,
        knownPlaylistId: ws.playlistId,
      })

      // Update known playlist ID
      ws.playlistId = playlistId
    } catch (err) {
      log.warning(`Failed to sync playlist for user ${userId}:`, err)

      // If it's a 404, reset the playlist ID so it gets recreated next time
      if (err instanceof Error && err.message.includes('not found')) {
        ws.playlistId = null
      }
    } finally {
      this.playlistSyncInProgress.set(userId, false)
    }
  }

  getExistingMatches(userId: number): Array<WebSocketMatchMessage['payload']> {
    const userLiked = getUserLikedGuids(userId)
    const matches = getRoomMatches(this.roomCode)

    // Filter to only matches where this user actually liked (not just swiped)
    return matches
      .filter(match => userLiked.has(match.movie.guid))
      .map(match => ({
        movie: match.movie,
        users: match.users,
      }))
  }
}

const activeSessions: Map<string, Session> = new Map()

export const getSession = (roomCode: string): Session => {
  if (activeSessions.has(roomCode)) {
    return activeSessions.get(roomCode)!
  }

  // Ensure room exists in database
  ensureRoom(roomCode)

  const session = new Session(roomCode)

  // Load media from database
  session.movieListCache = getRoomMedia(roomCode)

  activeSessions.set(roomCode, session)

  log.debug(
    `New session created. Active session ids are: ${[
      ...activeSessions.keys(),
    ].join(', ')}`,
  )

  return session
}

export const handleLogin = (ws: WebSocket): Promise<SessionUser> => {
  return new Promise(resolve => {
    const handler = async (msg: string) => {
      try {
        const data: WebSocketMessage = JSON.parse(msg)

        if (data.type === 'login') {
          // Validate payload exists and has required fields
          if (
            !data.payload ||
            typeof data.payload !== 'object' ||
            typeof (data.payload as any).roomCode !== 'string' ||
            typeof (data.payload as any).name !== 'string'
          ) {
            log.info('Login rejected: invalid payload structure')
            const response: WebSocketLoginResponseMessage = {
              type: 'loginResponse',
              payload: {
                success: false,
                reason: 'Invalid login message format.',
              },
            }
            ws.send(JSON.stringify(response))
            return
          }

          // Extract password and validate it's not logged
          const password = (data.payload as any).password
          const hasPassword =
            typeof password === 'string' && password.length > 0

          // Validate inputs
          let roomCode = (data.payload.roomCode ?? '').trim().toUpperCase()
          let name = (data.payload.name ?? '').trim()
          let jellyfinAuthenticated = false
          let jellyfinSession: JellyfinSession | null = null

          // Validate roomCode format
          if (!/^[0-9A-Z]{4}$/.test(roomCode)) {
            log.info(
              `Login rejected: invalid room code format: ${data.payload.roomCode}`,
            )
            const response: WebSocketLoginResponseMessage = {
              type: 'loginResponse',
              payload: {
                success: false,
                reason:
                  'Invalid room code format. Must be 4 alphanumeric characters.',
              },
            }
            ws.send(JSON.stringify(response))
            return
          }

          // Validate name (initial length check for non-Jellyfin logins)
          if (!hasPassword && (name.length === 0 || name.length > 50)) {
            log.info(
              `Login rejected: invalid name length (${name.length} chars)`,
            )
            const response: WebSocketLoginResponseMessage = {
              type: 'loginResponse',
              payload: {
                success: false,
                reason:
                  name.length === 0
                    ? 'Name cannot be empty.'
                    : 'Name must be at most 50 characters.',
              },
            }
            ws.send(JSON.stringify(response))
            return
          }

          // Extract createPlaylist flag (only relevant with Jellyfin auth)
          const createPlaylist =
            typeof (data.payload as any).createPlaylist === 'boolean'
              ? (data.payload as any).createPlaylist
              : false

          // Handle Jellyfin authentication if password is provided
          if (hasPassword) {
            // Check if Jellyfin backend is enabled
            if (BACKEND !== 'jellyfin') {
              log.info(
                'Login rejected: Jellyfin login attempted but backend is not jellyfin',
              )
              const response: WebSocketLoginResponseMessage = {
                type: 'loginResponse',
                payload: {
                  success: false,
                  reason: 'Jellyfin login is not available with this backend.',
                },
              }
              ws.send(JSON.stringify(response))
              return
            }

            // Attempt Jellyfin authentication
            // Use the input name for Jellyfin, not trimmed yet for auth
            try {
              jellyfinSession = await authenticateJellyfinUser(name, password)
              // Use the Jellyfin-returned username for consistency
              name = jellyfinSession.userName
              jellyfinAuthenticated = true

              // Validate the returned username
              name = name.trim()
              if (name.length === 0 || name.length > 50) {
                log.warning(
                  'Jellyfin returned username with invalid length, rejecting login',
                )
                const response: WebSocketLoginResponseMessage = {
                  type: 'loginResponse',
                  payload: {
                    success: false,
                    reason: 'Jellyfin login failed.',
                  },
                }
                ws.send(JSON.stringify(response))
                return
              }
            } catch (err) {
              // Log error but not the password
              log.error('Jellyfin authentication failed:', err)
              const response: WebSocketLoginResponseMessage = {
                type: 'loginResponse',
                payload: {
                  success: false,
                  reason: 'Jellyfin login failed.',
                },
              }
              ws.send(JSON.stringify(response))
              return
            }
          } else {
            // Non-Jellyfin login: validate name already checked above
            if (name.length === 0) {
              log.info('Login rejected: empty name')
              const response: WebSocketLoginResponseMessage = {
                type: 'loginResponse',
                payload: {
                  success: false,
                  reason: 'Name cannot be empty.',
                },
              }
              ws.send(JSON.stringify(response))
              return
            }
          }

          log.info(
            `Got a login: roomCode=${roomCode}, name=${name}, jellyfinAuth=${jellyfinAuthenticated}`,
          )

          // Get active session (this also ensures room exists in database)
          const session = getSession(roomCode)

          // Get or create user in database
          const user = getOrCreateUser(roomCode, name)

          // Check if this user already has an active connection
          if (session.userConnections.has(user.id)) {
            const existingWs = session.userConnections.get(user.id)!
            if (!existingWs.isClosed) {
              log.info(`${name} is already logged in. Try another name!`)
              const response: WebSocketLoginResponseMessage = {
                type: 'loginResponse',
                payload: {
                  success: false,
                  reason: `${name} is already logged in.`,
                },
              }
              ws.send(JSON.stringify(response))
              return
            }
          }

          log.debug(`User ${name} (id=${user.id}) logged in`)

          // Store Jellyfin session in WebSocket connection (memory only)
          // Only enable playlist if authenticated AND createPlaylist is true
          if (jellyfinSession && createPlaylist) {
            ws.jellyfin = jellyfinSession
            ws.playlistEnabled = true
          }

          ws.removeListener('message', handler)
          session.addConnection(user.id, user.name, ws)

          const userSwiped = getUserSwipedGuids(user.id)
          const response: WebSocketLoginResponseMessage = {
            type: 'loginResponse',
            payload: {
              success: true,
              jellyfinAuthenticated,
              playlistEnabled: ws.playlistEnabled,
              matches: session.getExistingMatches(user.id),
              movies: session.movieListCache.filter(
                movie => !userSwiped.has(movie.guid),
              ),
            },
          }
          ws.send(JSON.stringify(response))

          return resolve(user)
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          log.warning(
            `Invalid JSON in login handler (length: ${msg.length} bytes)`,
          )
          const response: WebSocketLoginResponseMessage = {
            type: 'loginResponse',
            payload: {
              success: false,
              reason: 'Invalid message format.',
            },
          }
          ws.send(JSON.stringify(response))
        } else {
          log.error('Error in login handler:', err)
          const response: WebSocketLoginResponseMessage = {
            type: 'loginResponse',
            payload: {
              success: false,
              reason: 'An error occurred during login.',
            },
          }
          ws.send(JSON.stringify(response))
        }
      }
    }
    ws.addListener('message', handler)
  })
}
