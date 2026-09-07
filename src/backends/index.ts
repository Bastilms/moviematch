import { BACKEND } from '../config.js'
import { PlexBackend } from './plex.js'
import { JellyfinBackend } from './jellyfin.js'
import type { MediaBackend } from './types.js'

let instance: MediaBackend | null = null

export function getBackend(): MediaBackend {
  if (instance !== null) {
    return instance
  }

  if (BACKEND === 'plex') {
    instance = new PlexBackend()
  } else if (BACKEND === 'jellyfin') {
    instance = new JellyfinBackend()
  } else {
    throw new Error(`Unknown backend: ${BACKEND}`)
  }

  return instance
}
