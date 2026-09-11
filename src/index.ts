import http from 'node:http'
import { resolve } from 'node:path'
import * as log from './util/logger.js'
import { getBackend } from './backends/index.js'
import {
  LINK_TYPE,
  PORT,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_HTTP_PER_MINUTE,
  RATE_LIMIT_WS_PER_MINUTE,
  RATE_LIMIT_MESSAGES_PER_MINUTE,
  RATE_LIMIT_LOGIN_PER_MINUTE,
  SESSION_TTL_HOURS,
  TRUST_PROXY,
  DATABASE_PATH,
  BACKEND,
} from './config.js'
import { getLinkTypeForRequest } from './i18n.js'
import { handleLogin } from './session.js'
import { serveFile } from './util/staticFileServer.js'
import { WebSocketServer } from './util/websocketServer.js'
import {
  closeDatabase,
  getRoomMatches,
  roomExists,
  initDatabase,
  getUserLikes,
} from './db/database.js'
import { toCSV } from './util/csv.js'
import { createRateLimiter, getClientIp } from './util/rateLimit.js'
import type { RateLimiter } from './util/rateLimit.js'
import {
  createSession,
  getSession as getStoredSession,
  destroySession,
  stopSessionStore,
} from './util/sessionStore.js'
import {
  authenticateJellyfinUser,
  logoutJellyfinUser,
  fetchJellyfinAvatar,
} from './util/jellyfinUser.js'

const backend = getBackend()

// Initialize rate limiters
const httpRateLimiter: RateLimiter | null = RATE_LIMIT_ENABLED
  ? createRateLimiter(RATE_LIMIT_HTTP_PER_MINUTE)
  : null

const wsRateLimiter: RateLimiter | null = RATE_LIMIT_ENABLED
  ? createRateLimiter(RATE_LIMIT_WS_PER_MINUTE)
  : null

const messageRateLimiter: RateLimiter | null = RATE_LIMIT_ENABLED
  ? createRateLimiter(RATE_LIMIT_MESSAGES_PER_MINUTE)
  : null

const loginRateLimiter: RateLimiter | null = RATE_LIMIT_ENABLED
  ? createRateLimiter(RATE_LIMIT_LOGIN_PER_MINUTE)
  : null

// Hilfsfunktion zum Parsen des Cookie-Headers
function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!cookieHeader) {
    return cookies
  }

  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const name = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    if (name) {
      cookies[name] = value
    }
  }
  return cookies
}

// Set up logging for rate limit transitions
if (httpRateLimiter?.setLogger) {
  httpRateLimiter.setLogger((_, ip) => {
    log.warning(`Rate limit exceeded for HTTP requests from ${ip}`)
  })
}
if (wsRateLimiter?.setLogger) {
  wsRateLimiter.setLogger((_, ip) => {
    log.warning(`Rate limit exceeded for WebSocket connections from ${ip}`)
  })
}
if (messageRateLimiter?.setLogger) {
  messageRateLimiter.setLogger((_, ip) => {
    log.warning(`Rate limit exceeded for WebSocket messages from ${ip}`)
  })
}
if (loginRateLimiter?.setLogger) {
  loginRateLimiter.setLogger((_, ip) => {
    log.warning(`Rate limit exceeded for login attempts from ${ip}`)
  })
}

// Track sockets held for rate-limit backpressure
interface HeldSocket {
  socket: any
  timer: NodeJS.Timeout
}
const heldSockets: HeldSocket[] = []
const MAX_HELD_SOCKETS = 512
const HELD_SOCKET_TIMEOUT = 30_000 // 30 seconds

const wss = new WebSocketServer({
  onConnection: handleLogin,
  onError: err => log.error(err),
  messageRateLimiter: messageRateLimiter
    ? (ip: string) => messageRateLimiter.check(ip)
    : undefined,
  trustProxy: TRUST_PROXY,
})

const server = http.createServer(async (req, res) => {
  try {
    // Apply HTTP rate limit
    if (httpRateLimiter) {
      const clientIp = getClientIp(req, TRUST_PROXY)
      if (!httpRateLimiter.check(clientIp)) {
        // Rate limit exceeded: don't respond, let client timeout
        // Hold the socket for a bit and then destroy it
        if (req.socket) {
          if (heldSockets.length < MAX_HELD_SOCKETS) {
            const timer = setTimeout(() => {
              req.socket?.destroy()
              const index = heldSockets.findIndex(h => h.socket === req.socket)
              if (index !== -1) {
                heldSockets.splice(index, 1)
              }
            }, HELD_SOCKET_TIMEOUT)
            timer.unref()
            heldSockets.push({ socket: req.socket, timer })
          } else {
            // Too many held sockets, destroy immediately
            req.socket.destroy()
          }
        }
        return
      }
    }

    const url = req.url || '/'

    if (url === '/ws') {
      // WebSocket upgrade is handled separately, non-upgrade requests get 400
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('Bad Request')
      return
    } else if (url.startsWith('/movie/')) {
      const keyPart = url.slice('/movie/'.length)
      let key
      try {
        key = decodeURIComponent(keyPart)
      } catch (err) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      const linkType = getLinkTypeForRequest(req.headers)
      const effectiveLinkType = LINK_TYPE === 'plex.tv' ? 'plex.tv' : linkType

      const location = await backend.getDeepLink(key, effectiveLinkType)

      res.writeHead(302, {
        Location: location,
      })
      res.end()
    } else if (url.startsWith('/poster/')) {
      const posterKeyPart = url.slice('/poster/'.length)
      let posterKey
      try {
        posterKey = decodeURIComponent(posterKeyPart.split('?')[0])
      } catch (err) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      const [, search] = url.split('?')
      const searchParams = new URLSearchParams(search || '')

      const width = searchParams.has('w') ? Number(searchParams.get('w')) : 500

      if (Number.isNaN(width) || width <= 0 || width > 2000) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      try {
        const poster = await backend.getPoster(posterKey, width)

        res.writeHead(200, {
          'content-type': poster.contentType,
        })
        res.end(Buffer.from(poster.body))
      } catch (err) {
        log.error(`Failed to load poster ${posterKey}:`, err)
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
      }
    } else if (url === '/api/jellyfin-login') {
      // POST /api/jellyfin-login endpoint
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain' })
        res.end('Method Not Allowed')
        return
      }

      // Nur wenn Jellyfin-Backend aktiviert ist
      if (BACKEND !== 'jellyfin') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Rate-Limit für Login-Versuche prüfen
      const clientIp = getClientIp(req, TRUST_PROXY)
      if (loginRateLimiter && !loginRateLimiter.check(clientIp)) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end('')
        return
      }

      // Rumpfgröße auf 8 KB begrenzen
      let requestBody = ''
      const maxBodySize = 8 * 1024 // 8 KB

      req.on('data', chunk => {
        requestBody += chunk.toString('utf-8')
        if (requestBody.length > maxBodySize) {
          res.writeHead(413, { 'content-type': 'text/plain' })
          res.end('Payload Too Large')
          req.socket.destroy()
        }
      })

      req.on('end', async () => {
        try {
          // Rumpf parsen
          let body: {
            name?: unknown
            password?: unknown
            createPlaylist?: unknown
          }
          try {
            body = JSON.parse(requestBody)
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid JSON.' }))
            return
          }

          // Name und Passwort validieren
          const name = body.name
          const password = body.password
          const createPlaylist =
            typeof body.createPlaylist === 'boolean'
              ? body.createPlaylist
              : false

          if (typeof name !== 'string' || typeof password !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'Missing name or password.' }))
            return
          }

          // Jellyfin-Authentifizierung versuchen
          let session
          try {
            session = await authenticateJellyfinUser(name, password)
          } catch {
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'Jellyfin login failed.' }))
            return
          }

          // Wenn nicht createPlaylist: Token sofort beenden
          let accessToken: string | null = session.accessToken
          if (!createPlaylist) {
            await logoutJellyfinUser(accessToken)
            accessToken = null
          }

          // Sitzung erstellen
          const storedSession = {
            userId: session.userId,
            userName: session.userName,
            accessToken,
            createdAt: Date.now(),
          }
          const sessionId = createSession(storedSession)

          // Cookie setzen
          const ttlSeconds = SESSION_TTL_HOURS * 3600
          let setCookieValue = `mm_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttlSeconds}`

          // Secure Flag nur wenn HTTPS erkannt wird (via x-forwarded-proto)
          if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') {
            setCookieValue += '; Secure'
          }

          res.setHeader('Set-Cookie', setCookieValue)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              userName: session.userName,
              playlistEnabled: createPlaylist,
            }),
          )
        } catch (err) {
          log.error(`Error in /api/jellyfin-login endpoint: ${err}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'Internal Server Error' }))
          }
        }
      })
      return
    } else if (url === '/api/jellyfin-logout') {
      // POST /api/jellyfin-logout endpoint
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain' })
        res.end('Method Not Allowed')
        return
      }

      // Nur wenn Jellyfin-Backend aktiviert ist
      if (BACKEND !== 'jellyfin') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Cookie auslesen
      const cookies = parseCookies(req.headers.cookie)
      const sessionId = cookies.mm_session

      if (sessionId) {
        destroySession(sessionId)
      }

      // Cookie löschen (Max-Age=0)
      const deleteCookieValue =
        'mm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
      res.setHeader('Set-Cookie', deleteCookieValue)

      res.writeHead(204)
      res.end()
      return
    } else if (url === '/api/jellyfin-avatar') {
      // GET /api/jellyfin-avatar endpoint
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' })
        res.end('Method Not Allowed')
        return
      }

      // Nur wenn Jellyfin-Backend aktiviert ist
      if (BACKEND !== 'jellyfin') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Der Benutzer wird ausschliesslich aus der eigenen Sitzung bestimmt.
      // Der Aufrufer kann keine fremde Kennung angeben.
      const cookies = parseCookies(req.headers.cookie)
      const sessionId = cookies.mm_session
      const storedSession = sessionId ? getStoredSession(sessionId) : null

      if (!storedSession) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      try {
        const avatar = await fetchJellyfinAvatar(storedSession.userId, 96)

        if (!avatar) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('Not Found')
          return
        }

        res.writeHead(200, {
          'content-type': avatar.contentType,
          // Die Antwort haengt an der Sitzung. Wird sie zwischengespeichert,
          // liefert der Browser das Profilbild auch nach dem Abmelden noch
          // aus — gemessen ueber fuenf Minuten hinweg. Deshalb gar nicht erst
          // ablegen.
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(Buffer.from(avatar.body))
      } catch (err) {
        log.error(`Failed to load Jellyfin avatar: ${err}`)
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
      }
      return
    } else if (url.match(/^\/api\/rooms\/([0-9A-Za-z]+)\/likes\.csv/)) {
      // User likes export endpoint
      const match = url.match(/^\/api\/rooms\/([0-9A-Za-z]+)\/likes\.csv/)
      if (!match) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      let code = match[1].trim().toUpperCase()

      // Validate room code format
      if (!/^[0-9A-Z]{4}$/.test(code)) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Check if room exists
      if (!roomExists(code)) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Parse query parameters
      const [, searchPart] = url.split('?')
      const searchParams = new URLSearchParams(searchPart || '')
      let userName = searchParams.get('user')

      // Validate user parameter
      if (!userName) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Decode URL-encoded user name
      try {
        userName = decodeURIComponent(userName)
      } catch (err) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Trim and check length
      userName = userName.trim()
      if (userName.length === 0 || userName.length > 50) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      try {
        const likes = getUserLikes(code, userName)

        // Prepare CSV records
        const records = []
        for (const movie of likes) {
          let deepLink = ''

          try {
            deepLink = await backend.getDeepLink(movie.key, 'http')
          } catch (err) {
            log.debug(`Failed to get deep link for ${movie.key}:`, err)
          }

          records.push({
            Title: movie.title,
            Year: movie.year,
            Director: movie.director ?? '',
            Rating: movie.rating,
            Type: movie.type,
            Link: deepLink,
          })
        }

        const csv = toCSV(
          ['Title', 'Year', 'Director', 'Rating', 'Type', 'Link'],
          records,
        )

        // Sanitize file name: replace all characters except A-Za-z0-9-_ with _
        const sanitizedName = userName.replace(/[^A-Za-z0-9\-_]/g, '_')

        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="moviematch-${code}-${sanitizedName}.csv"`,
        })
        res.end(csv)
      } catch (err) {
        log.error(
          `Error generating likes CSV for room ${code}, user ${userName}:`,
          err,
        )
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('Internal Server Error')
      }
    } else if (url.match(/^\/api\/rooms\/([0-9A-Za-z]+)\/matches\.csv$/)) {
      // CSV export endpoint
      const match = url.match(/^\/api\/rooms\/([0-9A-Za-z]+)\/matches\.csv$/)
      if (!match) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      let code = match[1].trim().toUpperCase()

      // Validate room code format
      if (!/^[0-9A-Z]{4}$/.test(code)) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // Check if room exists
      if (!roomExists(code)) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }

      try {
        const matches = getRoomMatches(code)

        // Prepare CSV records
        const records = []
        for (const match of matches) {
          const movie = match.movie
          let deepLink = ''

          try {
            deepLink = await backend.getDeepLink(movie.key, 'http')
          } catch (err) {
            log.debug(`Failed to get deep link for ${movie.key}:`, err)
          }

          records.push({
            Title: movie.title,
            Year: movie.year,
            Director: movie.director ?? '',
            Rating: movie.rating,
            Type: movie.type,
            Likes: String(match.users.length),
            Users: match.users.join('; '),
            Link: deepLink,
          })
        }

        const csv = toCSV(
          [
            'Title',
            'Year',
            'Director',
            'Rating',
            'Type',
            'Likes',
            'Users',
            'Link',
          ],
          records,
        )

        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="moviematch-${code}.csv"`,
        })
        res.end(csv)
      } catch (err) {
        log.error(`Error generating CSV for room ${code}:`, err)
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('Internal Server Error')
      }
    } else {
      // Serve static files
      await serveFile(
        url,
        res,
        req.headers as Record<string, string | string[] | undefined>,
      )
    }
  } catch (err) {
    log.error(`Error handling request: ${err}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('Internal Server Error')
    }
  }
})

// Handle WebSocket upgrades
server.on('upgrade', (request, socket, head) => {
  const url = request.url || '/'

  if (url === '/ws') {
    // Apply WebSocket connection rate limit
    if (wsRateLimiter) {
      const clientIp = getClientIp(request, TRUST_PROXY)
      if (!wsRateLimiter.check(clientIp)) {
        // Rate limit exceeded: don't upgrade, let client timeout
        // Hold the socket for a bit and then destroy it
        if (heldSockets.length < MAX_HELD_SOCKETS) {
          const timer = setTimeout(() => {
            socket.destroy()
            const index = heldSockets.findIndex(h => h.socket === socket)
            if (index !== -1) {
              heldSockets.splice(index, 1)
            }
          }, HELD_SOCKET_TIMEOUT)
          timer.unref()
          heldSockets.push({ socket, timer })
        } else {
          // Too many held sockets, destroy immediately
          socket.destroy()
        }
        return
      }
    }

    // Versuche, die Sitzung aus dem Cookie zu laden
    const cookies = parseCookies(request.headers.cookie)
    const sessionId = cookies.mm_session
    const storedSession =
      sessionId && BACKEND === 'jellyfin' ? getStoredSession(sessionId) : null

    // Hänge die Sitzung an den Request an, damit sie später verfügbar ist
    ;(request as any)._jellyfinSession = storedSession

    wss.handleUpgrade(request, socket, head)
  } else {
    socket.destroy()
  }
})

// Graceful shutdown
const gracefulShutdown = () => {
  log.info('Shutting down')

  // Stop session store cleanup timer
  stopSessionStore()

  // Stop rate limiters
  if (httpRateLimiter) {
    httpRateLimiter.stop()
  }
  if (wsRateLimiter) {
    wsRateLimiter.stop()
  }
  if (messageRateLimiter) {
    messageRateLimiter.stop()
  }
  if (loginRateLimiter) {
    loginRateLimiter.stop()
  }

  // Clean up held sockets
  for (const held of heldSockets) {
    clearTimeout(held.timer)
    try {
      held.socket.destroy()
    } catch {}
  }
  heldSockets.length = 0

  wss.closeAll()
  server.closeAllConnections()
  closeDatabase()

  // Set a timeout to force exit if graceful shutdown takes too long
  const shutdownTimeout = setTimeout(() => {
    log.error('Graceful shutdown timeout, forcing exit')
    process.exit(1)
  }, 5000)

  server.close(() => {
    clearTimeout(shutdownTimeout)
    process.exit(0)
  })
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)

// Initialize database before starting the server
try {
  initDatabase()
  log.info(`Database ready at ${resolve(DATABASE_PATH)}`)
} catch (err) {
  log.critical(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

server.listen(Number(PORT), () => {
  log.info(`Listening on port ${PORT}`)

  // Preload media items in the background
  const startTime = Date.now()
  backend
    .getMediaItems()
    .then(items => {
      const duration = (Date.now() - startTime) / 1000
      log.info(
        `Preloaded ${items.length} titles from the media library in ${duration.toFixed(1)}s`,
      )
    })
    .catch(err => {
      log.warning(
        `Preloading the media library failed, it will be loaded on demand: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
})
