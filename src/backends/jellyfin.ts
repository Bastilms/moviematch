import { ok } from 'node:assert'
import * as log from '../util/logger.js'
import {
  DEFAULT_SECTION_TYPE_FILTER,
  LIBRARY_FILTER,
  COLLECTION_FILTER,
  JELLYFIN_URL,
  JELLYFIN_API_KEY,
  JELLYFIN_USER_ID,
  getVersion,
} from '../config.js'
import type { MediaBackend, MediaItem, Poster, LinkType } from './types.js'
import type {
  JellyfinUser,
  JellyfinView,
  JellyfinItem,
  JellyfinItemsResponse,
  JellyfinSystemInfo,
} from './jellyfin.types.js'

class JellyfinAuthError extends Error {}

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

// Validates Jellyfin user/item IDs: 32-char hex or GUID with hyphens
const JELLYFIN_ID_REGEX = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function validateJellyfinId(id: string, context: string): void {
  if (!JELLYFIN_ID_REGEX.test(id)) {
    throw new Error(
      `Invalid Jellyfin ID format (${context}): ${id}. Expected a 32-character hex string or GUID (e.g., "aabbccddeeff00112233445566778899" or "12345678-1234-5678-1234-567812345678").`
    )
  }
}

export class JellyfinBackend implements MediaBackend {
  readonly name = 'jellyfin' as const
  private mediaItems: MediaItem[] | null = null
  private loadingPromise: Promise<MediaItem[]> | null = null
  private userId: string | null = null
  private serverId: string | null = null

  constructor() {
    ok(typeof JELLYFIN_URL === 'string', 'A JELLYFIN_URL is required')
    ok(typeof JELLYFIN_API_KEY === 'string', 'A JELLYFIN_API_KEY is required')
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

  private async fetchAuthenticated(
    url: string,
    options?: RequestInit
  ): Promise<Response> {
    const headers = new Headers(options?.headers ?? {})
    headers.set(
      'Authorization',
      `MediaBrowser Token="${JELLYFIN_API_KEY}", Client="MovieMatch", Device="MovieMatch", DeviceId="moviematch", Version="${getVersion()}"`
    )
    headers.set('accept', 'application/json')

    log.debug(`Jellyfin API: ${url}`)

    const response = await fetch(url, {
      ...options,
      headers,
    })

    return response
  }

  private async getUserId(): Promise<string> {
    if (this.userId !== null) {
      return this.userId
    }

    if (JELLYFIN_USER_ID) {
      validateJellyfinId(
        JELLYFIN_USER_ID,
        'JELLYFIN_USER_ID environment variable'
      )
      this.userId = JELLYFIN_USER_ID
      return this.userId
    }

    const url = new URL(`${JELLYFIN_URL}/Users`)
    const response = await this.fetchAuthenticated(url.toString())

    if (!response.ok) {
      if (response.status === 401) {
        throw new JellyfinAuthError(`Authentication error: ${response.url}`)
      } else {
        const responseText = await response.text()
        throw new Error(
          `${response.url} returned ${response.status}: ${truncateResponseText(
            responseText
          )}`
        )
      }
    }

    const users: JellyfinUser[] = await response.json()

    ok(users.length > 0, 'No Jellyfin users found')

    this.userId = users[0].Id
    return this.userId
  }

  private async getServerId(): Promise<string> {
    if (this.serverId) {
      return this.serverId
    }

    const url = new URL(`${JELLYFIN_URL}/System/Info`)
    const response = await this.fetchAuthenticated(url.toString())

    if (!response.ok) {
      if (response.status === 401) {
        throw new JellyfinAuthError(`Authentication error: ${response.url}`)
      } else {
        const responseText = await response.text()
        throw new Error(
          `${response.url} returned ${response.status}: ${truncateResponseText(
            responseText
          )}`
        )
      }
    }

    const systemInfo: JellyfinSystemInfo = await response.json()
    this.serverId = systemInfo.Id
    return this.serverId
  }

  private async getSelectedViews(): Promise<JellyfinView[]> {
    const userId = await this.getUserId()

    const url = new URL(`${JELLYFIN_URL}/Users/${userId}/Views`)
    const response = await this.fetchAuthenticated(url.toString())

    if (!response.ok) {
      if (response.status === 401) {
        throw new JellyfinAuthError(`Authentication error: ${response.url}`)
      } else {
        const responseText = await response.text()
        throw new Error(
          `${response.url} returned ${response.status}: ${truncateResponseText(
            responseText
          )}`
        )
      }
    }

    const data: { Items?: JellyfinView[] } = await response.json()

    if (!Array.isArray(data.Items)) {
      throw new Error(
        `Unexpected response from ${response.url}: expected an "Items" array`
      )
    }

    const allViews = data.Items

    const availableViewNames = allViews.map(v => v.Name)
    log.debug(`Available libraries: ${availableViewNames.join(', ')}`)

    // Map DEFAULT_SECTION_TYPE_FILTER values to CollectionType
    const collectionTypeMap: Record<string, string> = {
      movie: 'movies',
      show: 'tvshows',
      artist: 'music',
      photo: 'homevideos',
    }

    let selectedViews: JellyfinView[] = []

    if (LIBRARY_FILTER === '') {
      // Use default: first view matching DEFAULT_SECTION_TYPE_FILTER
      const targetCollectionType =
        collectionTypeMap[DEFAULT_SECTION_TYPE_FILTER]
      const defaultView = allViews.find(
        v => v.CollectionType === targetCollectionType
      )

      if (defaultView) {
        selectedViews = [defaultView]
      }
    } else {
      // Use LIBRARY_FILTER: filter by name
      const filterNames = LIBRARY_FILTER.split(',').map(n => n.trim())
      selectedViews = allViews.filter(v => filterNames.includes(v.Name))
    }

    ok(
      selectedViews.length !== 0,
      `${LIBRARY_FILTER} did not match any available library names: ${availableViewNames.join(
        ', '
      )}`
    )

    return selectedViews
  }

  private async loadMediaItems(): Promise<MediaItem[]> {
    const userId = await this.getUserId()
    const selectedViews = await this.getSelectedViews()

    log.debug(`Selected views: ${selectedViews.map(v => v.Name).join(', ')}`)

    let allItems: JellyfinItem[] = []

    for (const view of selectedViews) {
      log.debug(`Loading items from ${view.Name} library`)

      // Determine includeItemTypes based on CollectionType
      let includeItemTypes: string | undefined
      if (view.CollectionType === 'movies') {
        includeItemTypes = 'Movie'
      } else if (view.CollectionType === 'tvshows') {
        includeItemTypes = 'Series'
      }
      // For other types, don't filter by includeItemTypes

      const items = await this.loadItemsFromView(
        userId,
        view.Id,
        includeItemTypes
      )

      log.debug(`Loaded ${items.length} items from ${view.Name}`)
      allItems.push(...items)
    }

    // Apply COLLECTION_FILTER if set
    if (COLLECTION_FILTER !== '') {
      allItems = await this.filterByCollections(userId, allItems)
    }

    // Map to MediaItem
    const result: MediaItem[] = []
    for (const item of allItems) {
      if (item.Type !== 'Movie' && item.Type !== 'Series') {
        continue
      }

      if (!item.ImageTags?.Primary) {
        log.debug(
          `Item ${item.Name} (id: ${item.Id}) has no Primary image, skipping`
        )
        continue
      }

      result.push({
        guid: item.Id,
        title: item.Name,
        summary: item.Overview ?? '',
        year: String(item.ProductionYear ?? ''),
        art: `/poster/${encodeURIComponent(item.Id)}`,
        director: (item.People ?? []).find(p => p.Type === 'Director')?.Name,
        rating: String(item.CommunityRating ?? ''),
        key: item.Id,
        type: item.Type === 'Movie' ? 'movie' : 'show',
      })
    }

    return result
  }

  private async loadItemsFromView(
    userId: string,
    viewId: string,
    includeItemTypes?: string
  ): Promise<JellyfinItem[]> {
    const allItems: JellyfinItem[] = []
    let startIndex = 0
    const limit = 500

    while (true) {
      const url = new URL(`${JELLYFIN_URL}/Items`)
      url.searchParams.set('userId', userId)
      url.searchParams.set('parentId', viewId)
      url.searchParams.set('recursive', 'true')
      url.searchParams.set('fields', 'Overview,People,ProductionYear')
      url.searchParams.set('sortBy', 'SortName')
      url.searchParams.set('startIndex', String(startIndex))
      url.searchParams.set('limit', String(limit))

      if (includeItemTypes) {
        url.searchParams.set('includeItemTypes', includeItemTypes)
      }

      const response = await this.fetchAuthenticated(url.toString())

      if (!response.ok) {
        if (response.status === 401) {
          throw new JellyfinAuthError(`Authentication error: ${response.url}`)
        } else {
          const responseText = await response.text()
          throw new Error(
            `${response.url} returned ${
              response.status
            }: ${truncateResponseText(responseText)}`
          )
        }
      }

      const data: {
        Items?: JellyfinItem[]
        TotalRecordCount?: number
      } = await response.json()

      if (!Array.isArray(data.Items)) {
        throw new Error(
          `Unexpected response from ${response.url}: expected an "Items" array`
        )
      }

      // Break early if server returns no items for this page
      if (data.Items.length === 0) {
        // If we got fewer items than expected, log a warning
        const totalRecordCount =
          typeof data.TotalRecordCount === 'number'
            ? data.TotalRecordCount
            : null
        if (totalRecordCount !== null && allItems.length < totalRecordCount) {
          log.warning(
            `Jellyfin /Items stopped returning items early (viewId: ${viewId}). Loaded ${allItems.length} of ${totalRecordCount} expected items.`
          )
        }
        break
      }

      allItems.push(...data.Items)

      // Validate TotalRecordCount before using it
      const totalRecordCount =
        typeof data.TotalRecordCount === 'number' ? data.TotalRecordCount : null
      if (totalRecordCount === null) {
        // Missing or invalid TotalRecordCount: stop after first page
        break
      }

      if (allItems.length >= totalRecordCount) {
        break
      }

      // Derive startIndex from actual items loaded to stay in sync
      startIndex = allItems.length
    }

    return allItems
  }

  private async filterByCollections(
    userId: string,
    items: JellyfinItem[]
  ): Promise<JellyfinItem[]> {
    const filterNames = COLLECTION_FILTER.split(',').map(n =>
      n.trim().toLowerCase()
    )

    // Load BoxSets
    const url = new URL(`${JELLYFIN_URL}/Items`)
    url.searchParams.set('userId', userId)
    url.searchParams.set('recursive', 'true')
    url.searchParams.set('includeItemTypes', 'BoxSet')

    const response = await this.fetchAuthenticated(url.toString())

    if (!response.ok) {
      if (response.status === 401) {
        throw new JellyfinAuthError(`Authentication error: ${response.url}`)
      } else {
        const responseText = await response.text()
        throw new Error(
          `${response.url} returned ${response.status}: ${truncateResponseText(
            responseText
          )}`
        )
      }
    }

    const data: { Items?: JellyfinItem[] } = await response.json()

    if (!Array.isArray(data.Items)) {
      throw new Error(
        `Unexpected response from ${response.url}: expected an "Items" array`
      )
    }

    const boxSets = data.Items.filter(bs =>
      filterNames.includes(bs.Name.toLowerCase().trim())
    )

    // For each matching BoxSet, load its items and collect their IDs
    const itemIds = new Set<string>()
    for (const boxSet of boxSets) {
      const boxSetUrl = new URL(`${JELLYFIN_URL}/Items`)
      boxSetUrl.searchParams.set('userId', userId)
      boxSetUrl.searchParams.set('parentId', boxSet.Id)
      boxSetUrl.searchParams.set('recursive', 'true')

      const boxSetResponse = await this.fetchAuthenticated(boxSetUrl.toString())

      if (!boxSetResponse.ok) {
        if (boxSetResponse.status === 401) {
          throw new JellyfinAuthError(
            `Authentication error: ${boxSetResponse.url}`
          )
        } else {
          const responseText = await boxSetResponse.text()
          throw new Error(
            `${boxSetResponse.url} returned ${
              boxSetResponse.status
            }: ${truncateResponseText(responseText)}`
          )
        }
      }

      const boxSetData: { Items?: JellyfinItem[] } = await boxSetResponse.json()

      if (!Array.isArray(boxSetData.Items)) {
        throw new Error(
          `Unexpected response from ${boxSetResponse.url}: expected an "Items" array`
        )
      }

      for (const item of boxSetData.Items) {
        itemIds.add(item.Id)
      }
    }

    // Filter items to only those in the collection
    return items.filter(item => itemIds.has(item.Id))
  }

  async getPoster(posterKey: string, width: number): Promise<Poster> {
    validateJellyfinId(posterKey, 'posterKey')

    const height = Math.round(width * 1.5)

    const url = new URL(`${JELLYFIN_URL}/Items/${posterKey}/Images/Primary`)
    url.searchParams.set('fillWidth', String(width))
    url.searchParams.set('fillHeight', String(height))

    const response = await this.fetchAuthenticated(url.toString())

    if (!response.ok) {
      if (response.status === 401) {
        throw new JellyfinAuthError(`Authentication error: ${response.url}`)
      } else {
        const responseText = await response.text()
        throw new Error(
          `${response.url} returned ${response.status}: ${truncateResponseText(
            responseText
          )}`
        )
      }
    }

    const buffer = await response.arrayBuffer()
    const contentType = response.headers.get('content-type') ?? 'image/jpeg'

    return {
      body: new Uint8Array(buffer),
      contentType,
    }
  }

  async getDeepLink(key: string, _linkType: LinkType): Promise<string> {
    const serverId = await this.getServerId()

    // Jellyfin doesn't have app deep links, always return web link
    // (linkType parameter is intentionally unused)
    return `${JELLYFIN_URL}/web/index.html#/details?id=${encodeURIComponent(
      key
    )}&serverId=${serverId}`
  }
}
