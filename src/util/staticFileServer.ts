import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'node:http'
import * as log from './logger.js'
import { translateHTML } from '../i18n.js'

function normalizeURL(url: string): string {
  let normalizedUrl = url
  try {
    normalizedUrl = decodeURI(normalizedUrl)
  } catch (e) {
    if (!(e instanceof URIError)) {
      throw e
    }
  }
  normalizedUrl = normalize(normalizedUrl)
  const startOfParams = normalizedUrl.indexOf('?')
  return startOfParams > -1
    ? normalizedUrl.slice(0, startOfParams)
    : normalizedUrl
}

export async function serveFile(
  url: string,
  res: ServerResponse,
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  // Resolve base directory relative to this module
  const baseDir = join(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    '..',
    'public',
  )

  const normalizedPath = join(
    baseDir,
    url === '/' ? '/index.html' : normalizeURL(url),
  )

  log.debug(`serveFile(${normalizedPath})`)

  // Security check: ensure resolved path is within baseDir
  // Use relative path to check for directory traversal
  const relPath = relative(resolve(baseDir), resolve(normalizedPath))
  if (relPath.startsWith('..')) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not Found')
    return
  }

  try {
    const fileStat = await stat(normalizedPath)
    if (!fileStat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not Found')
      return
    }

    let body: string | Buffer = await readFile(normalizedPath)

    if (extname(normalizedPath) === '.html') {
      const headersRecord: Record<string, string> = {}
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string') {
          headersRecord[key] = value
        }
      }
      body = await translateHTML(body, headersRecord)
    }

    res.writeHead(200, {
      'content-type': getContentType(normalizedPath),
    })
    res.end(body)
  } catch (err) {
    log.debug(`serveFile error: ${err}`)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not Found')
  }
}

const getContentType = (path: string): string => {
  const MIME_MAP: Record<string, string> = {
    '.html': 'text/html',
    '.json': 'application/json',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.js': 'application/javascript',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
  }

  return MIME_MAP[extname(path)] ?? 'text/plain'
}
