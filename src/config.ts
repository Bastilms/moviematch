import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setLevel, debug, addRedactedValue } from './util/logger.js'

// Load .env file if it exists
try {
  process.loadEnvFile()
} catch {
  // No .env file, that's fine
}

const getEnvTrimmed = (name: string): string | undefined => {
  const value = process.env[name]
  if (typeof value === 'string') {
    return value.trim()
  }
  return undefined
}

export const PLEX_URL = getEnvTrimmed('PLEX_URL')?.replace(/\/$/, '')
export const PLEX_TOKEN = getEnvTrimmed('PLEX_TOKEN')
export const PORT = getEnvTrimmed('PORT') ?? '8000'
export const LOG_LEVEL = getEnvTrimmed('LOG_LEVEL') ?? 'INFO'
export const MOVIE_BATCH_SIZE = getEnvTrimmed('MOVIE_BATCH_SIZE') ?? '25'
export const LINK_TYPE = getEnvTrimmed('LINK_TYPE') ?? 'app'
export const DEFAULT_SECTION_TYPE_FILTER =
  getEnvTrimmed('DEFAULT_SECTION_TYPE_FILTER') ?? 'movie'
export const LIBRARY_FILTER = getEnvTrimmed('LIBRARY_FILTER') ?? ''
export const COLLECTION_FILTER = getEnvTrimmed('COLLECTION_FILTER') ?? ''
export const ROOT_PATH = getEnvTrimmed('ROOT_PATH') ?? ''

export const BACKEND = (getEnvTrimmed('BACKEND') ?? 'plex').toLowerCase()
if (BACKEND !== 'plex' && BACKEND !== 'jellyfin') {
  throw new Error(`BACKEND must be 'plex' or 'jellyfin', got '${BACKEND}'`)
}

export const JELLYFIN_URL = getEnvTrimmed('JELLYFIN_URL')?.replace(/\/$/, '')
export const JELLYFIN_API_KEY = getEnvTrimmed('JELLYFIN_API_KEY')
export const JELLYFIN_USER_ID = getEnvTrimmed('JELLYFIN_USER_ID')

export const DATABASE_PATH =
  getEnvTrimmed('DATABASE_PATH') ?? './data/moviematch.db'

let versionCache: string | null = null

export function getVersion(): string {
  if (versionCache !== null) {
    return versionCache
  }

  try {
    const pkgPath = join(
      fileURLToPath(import.meta.url),
      '..',
      '..',
      'package.json'
    )
    const pkgText = readFileSync(pkgPath, 'utf-8')
    const pkg: { version: string } = JSON.parse(pkgText)
    versionCache = pkg.version
    return versionCache
  } catch (err) {
    console.error('Failed to read version from package.json:', err)
    return '0.0.0'
  }
}

// Initialize logger
setLevel(LOG_LEVEL)

// Register secrets to be redacted from logs
if (PLEX_TOKEN) {
  addRedactedValue(PLEX_TOKEN)
}
if (JELLYFIN_API_KEY) {
  addRedactedValue(JELLYFIN_API_KEY)
}

debug(`Log level ${LOG_LEVEL}`)
debug(`Backend: ${BACKEND}`)
