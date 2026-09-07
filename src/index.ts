import http from 'node:http'
import * as log from './util/logger.js'
import { getBackend } from './backends/index.js'
import {
  LINK_TYPE,
  PORT,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_HTTP_PER_MINUTE,
  RATE_LIMIT_WS_PER_MINUTE,
  RATE_LIMIT_MESSAGES_PER_MINUTE,
  TRUST_PROXY,
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
} from './db/database.js'
import { toCSV } from './util/csv.js'
import { createRateLimiter, getClientIp } from './util/rateLimit.js'
import type { RateLimiter } from './util/rateLimit.js'

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
          records
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
        req.headers as Record<string, string | string[] | undefined>
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

    wss.handleUpgrade(request, socket, head)
  } else {
    socket.destroy()
  }
})

// Graceful shutdown
const gracefulShutdown = () => {
  log.info('Shutting down')

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
} catch (err) {
  log.critical(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

server.listen(Number(PORT), () => {
  log.info(`Listening on port ${PORT}`)
})
