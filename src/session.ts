import * as log from './util/logger.js'
import { getBackend } from './backends/index.js'
import { MOVIE_BATCH_SIZE } from './config.js'
import { WebSocket } from './util/websocketServer.js'
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

type WebSocketMessage =
  | WebSocketLoginMessage
  | WebSocketResponseMessage
  | WebSocketNextBatchMessage

interface SessionUser {
  id: number
  name: string
}

class Session {
  roomCode: string
  userConnections: Map<number, WebSocket> = new Map()
  movieListCache: MediaItem[] = []

  constructor(roomCode: string) {
    this.roomCode = roomCode
  }

  addConnection = (userId: number, name: string, ws: WebSocket) => {
    this.userConnections.set(userId, ws)

    ws.addListener('message', msg => this.handleMessage(userId, name, msg))
    ws.addListener('close', () => this.removeConnection(userId, name))
  }

  removeConnection = (userId: number, name: string) => {
    log.debug(`User ${name} (id=${userId}) connection closed`)
    this.userConnections.delete(userId)

    if (this.userConnections.size === 0) {
      log.debug(
        `Session ${this.roomCode} has no active connections, removing from active sessions (data persists in database)`
      )
      activeSessions.delete(this.roomCode)
    }
  }

  handleMessage = async (userId: number, name: string, msg: string) => {
    try {
      const decodedMessage: WebSocketMessage = JSON.parse(msg)
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
              `${name} tried to rate a movie that doesn't exist in room: ${guid}`
            )
            return
          }

          // Check if already swiped
          const userSwiped = getUserSwipedGuids(userId)
          if (userSwiped.has(guid)) {
            log.warning(
              `User ${name} tried to respond to ${guid} twice! Ignoring.`
            )
            return
          }

          log.debug(
            `${name} ${
              wantsToWatch ? 'wants to watch' : 'does not want to watch'
            } ${guid}`
          )

          const isNew = recordSwipe(userId, guid, wantsToWatch)
          if (!isNew) {
            log.warning(`Swipe not recorded (duplicate) for ${name} / ${guid}`)
            return
          }

          if (wantsToWatch) {
            const likers = getLikersForMedia(this.roomCode, guid)
            if (likers.length >= 2) {
              const movie = this.movieListCache.find(m => m.guid === guid)
              if (movie) {
                this.broadcastMatch(movie, likers)
              }
            }
          }
          break
        }
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        // Invalid JSON - log but don't crash
        log.warning(`Invalid JSON received: ${msg}`)
      } else {
        log.error(err, JSON.stringify(msg))
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
        item => !distributedGuids.has(item.guid)
      )

      if (candidates.length === 0) {
        // No more movies
        for (const ws of this.userConnections.values()) {
          if (!ws.isClosed) {
            ws.send(
              JSON.stringify({
                type: 'batch',
                payload: [],
              })
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
            movie => !userSwiped.has(movie.guid)
          )
          ws.send(
            JSON.stringify({
              type: 'batch',
              payload: filteredBatch,
            })
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
    ].join(', ')}`
  )

  return session
}

export const handleLogin = (ws: WebSocket): Promise<SessionUser> => {
  return new Promise(resolve => {
    const handler = (msg: string) => {
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

          // Validate inputs
          let roomCode = (data.payload.roomCode ?? '').trim().toUpperCase()
          let name = (data.payload.name ?? '').trim()

          // Validate roomCode format
          if (!/^[0-9A-Z]{4}$/.test(roomCode)) {
            log.info(
              `Login rejected: invalid room code format: ${data.payload.roomCode}`
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

          // Validate name
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

          if (name.length > 50) {
            log.info('Login rejected: name too long')
            const response: WebSocketLoginResponseMessage = {
              type: 'loginResponse',
              payload: {
                success: false,
                reason: 'Name must be at most 50 characters.',
              },
            }
            ws.send(JSON.stringify(response))
            return
          }

          log.info(`Got a login: roomCode=${roomCode}, name=${name}`)

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

          ws.removeListener('message', handler)
          session.addConnection(user.id, user.name, ws)

          const userSwiped = getUserSwipedGuids(user.id)
          const response: WebSocketLoginResponseMessage = {
            type: 'loginResponse',
            payload: {
              success: true,
              matches: session.getExistingMatches(user.id),
              movies: session.movieListCache.filter(
                movie => !userSwiped.has(movie.guid)
              ),
            },
          }
          ws.send(JSON.stringify(response))

          return resolve(user)
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          log.warning(`Invalid JSON in login handler: ${msg}`)
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
