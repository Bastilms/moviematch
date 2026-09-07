import http from 'node:http'
import * as log from './util/logger.js'
import { getBackend } from './backends/index.js'
import { LINK_TYPE, PORT } from './config.js'
import { getLinkTypeForRequest } from './i18n.js'
import { handleLogin } from './session.js'
import { serveFile } from './util/staticFileServer.js'
import { WebSocketServer } from './util/websocketServer.js'
import { closeDatabase, getRoomMatches, roomExists } from './db/database.js'
import { toCSV } from './util/csv.js'

const backend = getBackend()

const wss = new WebSocketServer({
  onConnection: handleLogin,
  onError: err => log.error(err),
})

const server = http.createServer(async (req, res) => {
  try {
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
    wss.handleUpgrade(request, socket, head)
  } else {
    socket.destroy()
  }
})

// Graceful shutdown
const gracefulShutdown = () => {
  log.info('Shutting down')
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

server.listen(Number(PORT), () => {
  log.info(`Listening on port ${PORT}`)
})
