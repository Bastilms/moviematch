import { ok } from 'node:assert'
import * as log from '../util/logger.js'
import {
  DEFAULT_SECTION_TYPE_FILTER,
  LIBRARY_FILTER,
  COLLECTION_FILTER,
  PLEX_TOKEN,
  PLEX_URL,
} from '../config.js'
import type { MediaBackend, MediaItem, Poster, LinkType } from './types.js'
import type {
  PlexDirectory,
  PlexMediaContainer,
  PlexMediaProviders,
  PlexVideo,
} from './plex.types.js'

class PlexTokenError extends Error {}

/**
 * Extract the base URL (protocol + host + path) without query string.
 * Useful for logging URLs without exposing secrets in query parameters.
 */
function getBaseUrl(urlString: string): string {
  try {
    const url = new URL(urlString)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    // If URL parsing fails, return the original string (shouldn't happen with Response.url)
    return urlString
  }
}

/**
 * Truncate response text to a reasonable length to prevent log flooding.
 * Max 500 characters; marks truncation if exceeded.
 */
function truncateResponseText(text: string, maxLength: number = 500): string {
  if (text.length <= maxLength) {
    return text
  }
  return (
    text.substring(0, maxLength) +
    `... [truncated, ${text.length - maxLength} more chars]`
  )
}

export class PlexBackend implements MediaBackend {
  readonly name = 'plex' as const
  private mediaItems: MediaItem[] | null = null
  private loadingPromise: Promise<MediaItem[]> | null = null
  private serverId: string | null = null

  constructor() {
    ok(typeof PLEX_URL === 'string', 'A PLEX_URL is required')
    ok(typeof PLEX_TOKEN === 'string', 'A PLEX_TOKEN is required')
    ok(
      !PLEX_TOKEN.startsWith('claim-'),
      'Your PLEX_TOKEN does not look right. Please see: https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/',
    )
  }

  async getMediaItems(): Promise<MediaItem[]> {
    if (this.mediaItems !== null) {
      return this.mediaItems
    }

    if (this.loadingPromise !== null) {
      return this.loadingPromise
    }

    this.loadingPromise = this.loadMediaItems()
    try {
      this.mediaItems = await this.loadingPromise
      return this.mediaItems
    } catch (err) {
      // Clear loading promise on error so next call retries
      this.loadingPromise = null
      throw err
    }
  }

  private async getSections(): Promise<PlexMediaContainer<PlexDirectory>> {
    log.debug(`getSections: ${PLEX_URL}/library/sections`)

    const req = await fetch(
      `${PLEX_URL}/library/sections?X-Plex-Token=${PLEX_TOKEN}`,
      {
        headers: { accept: 'application/json' },
      },
    )

    if (req.ok) {
      return await req.json()
    } else if (req.status === 401) {
      throw new PlexTokenError(`Authentication error: ${getBaseUrl(req.url)}`)
    } else {
      throw new Error(await req.text())
    }
  }

  private getSelectedLibraryTitles(
    sections: PlexMediaContainer<PlexDirectory>,
  ): string[] {
    const availableLibraryNames = sections.MediaContainer.Directory.map(
      _ => _.title,
    )
    log.debug(`Available libraries: ${availableLibraryNames.join(', ')}`)

    const defaultLibraryName = sections.MediaContainer.Directory.find(
      ({ hidden, type }) =>
        hidden !== 1 && type === DEFAULT_SECTION_TYPE_FILTER,
    )?.title

    const libraryTitles =
      (LIBRARY_FILTER === '' ? defaultLibraryName : LIBRARY_FILTER)
        ?.split(',')
        .filter(title => availableLibraryNames.includes(title)) ?? []

    ok(
      libraryTitles.length !== 0,
      `${LIBRARY_FILTER} did not match any available library names: ${availableLibraryNames.join(
        ', ',
      )}`,
    )

    return libraryTitles
  }

  private async loadMediaItems(): Promise<MediaItem[]> {
    const sections = await this.getSections()

    const selectedLibraryTitles = this.getSelectedLibraryTitles(sections)

    log.debug(`selected library titles - ${selectedLibraryTitles.join(', ')}`)

    const movieSections = sections.MediaContainer.Directory.filter(
      ({ title, hidden }) =>
        hidden !== 1 && selectedLibraryTitles.includes(title),
    )

    ok(movieSections.length !== 0, `Couldn't find a movies section in Plex!`)

    const movies: PlexVideo['Metadata'] = []

    for (const movieSection of movieSections) {
      log.debug(`Loading movies from ${movieSection.title} library`)

      const req = await fetch(
        `${PLEX_URL}/library/sections/${movieSection.key}/all?X-Plex-Token=${PLEX_TOKEN}`,
        {
          headers: { accept: 'application/json' },
        },
      )

      log.debug(
        `Loaded ${getBaseUrl(req.url)}: ${req.status} ${req.statusText}`,
      )

      if (!req.ok) {
        if (req.status === 401) {
          throw new PlexTokenError(
            `Authentication error: ${getBaseUrl(req.url)}`,
          )
        } else {
          const responseText = await req.text()
          throw new Error(
            `${getBaseUrl(req.url)} returned ${
              req.status
            }: ${truncateResponseText(responseText)}`,
          )
        }
      }

      const libraryData: PlexMediaContainer<PlexVideo> = await req.json()
      let metadata = libraryData.MediaContainer.Metadata

      if (COLLECTION_FILTER !== '') {
        const collectionFilter = COLLECTION_FILTER.split(',')
        metadata = metadata.filter(metadataItem => {
          return metadataItem.Collection?.find(collection =>
            collectionFilter.find(
              filter => filter.toLowerCase() === collection.tag.toLowerCase(),
            ),
          )
        })
      }

      if (!metadata) {
        log.info(
          `${libraryData.MediaContainer.librarySectionTitle} does not have any items. Skipping.`,
        )
        log.debug(JSON.stringify(libraryData, null, 2))
        continue
      }

      ok(
        metadata?.length,
        `${movieSection.title} doesn't appear to have any movies`,
      )

      log.debug(`Loaded ${metadata?.length} items from ${movieSection.title}`)

      movies.push(...metadata)
    }

    const result: MediaItem[] = []
    for (const movie of movies) {
      if (!movie.thumb) {
        const movieTitle = String(movie.title ?? 'Unknown')
        log.debug(
          `Item ${movieTitle} (guid: ${movie.guid}) has no thumb, skipping`,
        )
        continue
      }

      if (!movie.guid) {
        const movieTitle = String(movie.title ?? 'Unknown')
        log.debug(`Item ${movieTitle} has no guid, skipping`)
        continue
      }

      result.push({
        guid: String(movie.guid),
        title: String(movie.title ?? ''),
        summary: String(movie.summary ?? ''),
        year: String(movie.year ?? ''),
        art: `/poster/${encodeURIComponent(
          movie.thumb.replace('/library/metadata/', ''),
        )}`,
        director: (movie.Director ?? [{ tag: undefined }])[0].tag,
        rating: String(movie.rating ?? ''),
        key: String(movie.key ?? ''),
        type: movie.type,
      })
    }
    return result
  }

  async getPoster(posterKey: string, width: number): Promise<Poster> {
    // Validate posterKey format
    if (!/^\d+\/(art|thumb)\/\d+$/.test(posterKey)) {
      throw new Error(`Invalid posterKey format: ${posterKey}`)
    }

    const height = width * 1.5

    const posterUrl = encodeURIComponent(`/library/metadata/${posterKey}`)
    const url = `${PLEX_URL}/photo/:/transcode?X-Plex-Token=${PLEX_TOKEN}&width=${width}&height=${height}&minSize=1&upscale=1&url=${posterUrl}`

    const posterReq = await fetch(url)

    if (!posterReq.ok) {
      if (posterReq.status === 401) {
        throw new PlexTokenError(
          `Authentication error: ${getBaseUrl(posterReq.url)}`,
        )
      } else {
        const responseText = await posterReq.text()
        throw new Error(
          `${getBaseUrl(posterReq.url)} returned ${
            posterReq.status
          }: ${truncateResponseText(responseText)}`,
        )
      }
    }

    const buffer = await posterReq.arrayBuffer()
    const contentType = posterReq.headers.get('content-type') ?? 'image/jpeg'

    return {
      body: new Uint8Array(buffer),
      contentType,
    }
  }

  async getDeepLink(key: string, linkType: LinkType): Promise<string> {
    const serverId = await this.getServerId()

    if (linkType === 'app') {
      return `plex://preplay/?metadataKey=${encodeURIComponent(
        key,
      )}&metadataType=1&server=${serverId}`
    } else if (linkType === 'plex.tv') {
      return `https://app.plex.tv/desktop#!/server/${serverId}/details?key=${encodeURIComponent(
        key,
      )}`
    } else {
      return `${PLEX_URL}/web/index.html#!/server/${serverId}/details?key=${encodeURIComponent(
        key,
      )}`
    }
  }

  private async getServerId(): Promise<string> {
    if (this.serverId) return this.serverId

    const req = await fetch(
      `${PLEX_URL}/media/providers?X-Plex-Token=${PLEX_TOKEN}`,
      {
        headers: { accept: 'application/json' },
      },
    )

    if (!req.ok) {
      if (req.status === 401) {
        throw new PlexTokenError(`Authentication error: ${getBaseUrl(req.url)}`)
      } else {
        const responseText = await req.text()
        throw new Error(
          `${getBaseUrl(req.url)} returned ${
            req.status
          }: ${truncateResponseText(responseText)}`,
        )
      }
    }

    const providers: PlexMediaProviders = await req.json()
    this.serverId = providers.MediaContainer.machineIdentifier
    return this.serverId
  }
}
