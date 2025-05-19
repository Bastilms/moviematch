import { serve } from 'https://deno.land/std@0.79.0/http/server.ts'
import * as log from 'https://deno.land/std@0.79.0/log/mod.ts'
import { getServerId, proxyPoster } from './api/plex.ts'
import { PLEX_URL, PORT, LINK_TYPE, JELLYFIN_URL, JELLYFIN_API_KEY } from './config.ts'
import { getLinkTypeForRequest } from './i18n.ts'
import { handleLogin } from './session.ts'
import { serveFile } from './util/staticFileServer.ts'
import { WebSocketServer } from './util/websocketServer.ts'

const server = serve({ port: Number(PORT) })

const wss = new WebSocketServer({
  onConnection: handleLogin,
  onError: err => log.error(err),
})

if (Deno.build.os !== 'windows') {
  Deno.signal(Deno.Signal.SIGINT).then(() => {
    log.info('Shutting down')
    server.close()
    Deno.exit(0)
  })
}

log.info(`Listening on port ${PORT}`)

for await (const req of server) {
  try {
    if (req.url === '/ws') {
      wss.connect(req)
    } else if (req.url.startsWith('/movie/')) {
      const serverId = await getServerId()
      const key = req.url.replace('/movie', '')

      let location: string

      if (getLinkTypeForRequest(req.headers) === 'app') {
        location = `plex://preplay/?metadataKey=${encodeURIComponent(
          key
        )}&metadataType=1&server=${serverId}`
      } else if (LINK_TYPE == 'plex.tv') {
        location = `https://app.plex.tv/desktop#!/server/${serverId}/details?key=${encodeURIComponent(
          key
        )}`
      } else {
        location = `${PLEX_URL}/web/index.html#!/server/${serverId}/details?key=${encodeURIComponent(
          key
        )}`
      }

      await req.respond({
        status: 302,
        headers: new Headers({
          Location: location,
        }),
      })
    } else if (req.url.startsWith('/poster/')) {
      const [, key] =
        req.url.match(/\/poster\/([0-9]+\/(art|thumb)\/[0-9]+)/) ?? []

      if (!key) {
        await req.respond({ status: 404 })
      } else {
        await proxyPoster(req, key)
      }
    } else if (req.url.startsWith('/jellyfin/poster/')) {
      const id = req.url.replace('/jellyfin/poster/', '')
      const url = `${JELLYFIN_URL}/Items/${id}/Images/Primary`
      const res = await fetch(url, {
        headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
      })
      const body = new Uint8Array(await res.arrayBuffer())
      await req.respond({
        status: res.status,
        headers: new Headers({
          'Content-Type': res.headers.get('content-type') || 'image/jpeg'
        }),
        body
      })
    } else {
      serveFile(req, '/public')
    }
  } catch (err) {
    log.error(`Error handling request: ${err.message}`)
  }
}
