import * as log from './logger.js'
import { JELLYFIN_URL, getVersion } from '../config.js'
import type { JellyfinSession } from './jellyfinUser.js'

/**
 * Bringt die Playlist dieses Nutzers auf den angegebenen Stand.
 * Legt sie an, wenn nötig, ergänzt fehlende und entfernt überzählige Einträge,
 * und benennt sie um, wenn sich der Name geändert hat.
 * Gibt die Id der Playlist zurück.
 */
export async function syncPlaylist(opts: {
  session: JellyfinSession
  playlistName: string
  itemIds: string[]
  knownPlaylistId: string | null
}): Promise<string> {
  const { session, playlistName, itemIds, knownPlaylistId } = opts

  let playlistId: string | null = knownPlaylistId

  // Schritt 1: Playlist finden oder erstellen
  if (!playlistId) {
    const existingPlaylistId = await findPlaylistBySuffix(
      session,
      extractRoomCodeSuffix(playlistName),
    )
    if (existingPlaylistId) {
      playlistId = existingPlaylistId
    } else {
      playlistId = await createPlaylist(session, playlistName, itemIds)
      return playlistId
    }
  }

  // Schritt 2: Wenn Playlist existiert, abgleichen
  await syncPlaylistItems(session, playlistId, itemIds)

  // Schritt 3: Name ggf. aktualisieren
  await updatePlaylistName(session, playlistId, playlistName)

  return playlistId
}

/**
 * Extrahiert den Raumcode aus dem Playlistnamen (am Ende nach ` – `).
 * Beispiel: "Anna, Bert – ABCD" → "ABCD"
 */
function extractRoomCodeSuffix(playlistName: string): string {
  const parts = playlistName.split(' – ')
  return parts[parts.length - 1]
}

/**
 * Sucht eine Playlist des Nutzers, die auf diesem Raumcode endet.
 */
async function findPlaylistBySuffix(
  session: JellyfinSession,
  roomCodeSuffix: string,
): Promise<string | null> {
  try {
    const url = new URL(`${JELLYFIN_URL}/Items`)
    url.searchParams.set('userId', session.userId)
    url.searchParams.set('includeItemTypes', 'Playlist')
    url.searchParams.set('recursive', 'true')

    const response = await fetchUserAuthenticated(
      url.toString(),
      session.accessToken,
    )

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication failed')
      }
      const text = await response.text()
      throw new Error(
        `Jellyfin returned ${response.status}: ${truncateText(text)}`,
      )
    }

    const data = (await response.json()) as {
      Items?: Array<{ Id: string; Name: string }>
    }
    const playlists = data.Items ?? []

    for (const playlist of playlists) {
      if (playlist.Name.endsWith(`– ${roomCodeSuffix}`)) {
        return playlist.Id
      }
    }

    return null
  } catch (err) {
    log.warning(`Failed to find existing playlist for ${session.userId}:`, err)
    return null
  }
}

/**
 * Legt eine neue Playlist an.
 */
async function createPlaylist(
  session: JellyfinSession,
  playlistName: string,
  itemIds: string[],
): Promise<string> {
  try {
    const url = new URL(`${JELLYFIN_URL}/Playlists`)

    const body = {
      Name: playlistName,
      Ids: itemIds,
      UserId: session.userId,
      MediaType: 'Video',
    }

    const response = await fetchUserAuthenticated(
      url.toString(),
      session.accessToken,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
        },
      },
    )

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication failed')
      }
      const text = await response.text()
      throw new Error(
        `Jellyfin returned ${response.status}: ${truncateText(text)}`,
      )
    }

    const data = (await response.json()) as { Id?: string }
    if (!data.Id) {
      throw new Error('No playlist ID returned')
    }

    log.debug(`Created playlist ${data.Id} for ${session.userId}`)
    return data.Id
  } catch (err) {
    log.error(`Failed to create playlist for ${session.userId}:`, err)
    throw err
  }
}

/**
 * Synchronisiert die Items einer Playlist: ergänzt fehlende und entfernt überzählige.
 */
async function syncPlaylistItems(
  session: JellyfinSession,
  playlistId: string,
  desiredItemIds: string[],
): Promise<void> {
  try {
    // Ist-Stand auslesen
    const url = new URL(`${JELLYFIN_URL}/Playlists/${playlistId}/Items`)
    url.searchParams.set('userId', session.userId)

    const response = await fetchUserAuthenticated(
      url.toString(),
      session.accessToken,
    )

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication failed')
      }
      if (response.status === 404) {
        log.warning(`Playlist ${playlistId} not found (404)`)
        throw new Error('Playlist not found')
      }
      const text = await response.text()
      throw new Error(
        `Jellyfin returned ${response.status}: ${truncateText(text)}`,
      )
    }

    const data = (await response.json()) as {
      Items?: Array<{ Id: string; PlaylistItemId: string }>
    }
    const currentItems = data.Items ?? []

    const currentItemIds = new Set(currentItems.map(item => item.Id))
    const desiredSet = new Set(desiredItemIds)

    // Fehlende ergänzen
    const toAdd = desiredItemIds.filter(id => !currentItemIds.has(id))
    if (toAdd.length > 0) {
      const addUrl = new URL(`${JELLYFIN_URL}/Playlists/${playlistId}/Items`)
      addUrl.searchParams.set('ids', toAdd.join(','))
      addUrl.searchParams.set('userId', session.userId)

      const addResponse = await fetchUserAuthenticated(
        addUrl.toString(),
        session.accessToken,
        {
          method: 'POST',
        },
      )

      if (!addResponse.ok) {
        if (addResponse.status === 401) {
          throw new Error('Authentication failed')
        }
        const text = await addResponse.text()
        throw new Error(
          `Jellyfin returned ${addResponse.status}: ${truncateText(text)}`,
        )
      }

      log.debug(`Added ${toAdd.length} items to playlist ${playlistId}`)
    }

    // Überzählige entfernen
    const toRemoveEntryIds = currentItems
      .filter(item => !desiredSet.has(item.Id))
      .map(item => item.PlaylistItemId)

    if (toRemoveEntryIds.length > 0) {
      const removeUrl = new URL(`${JELLYFIN_URL}/Playlists/${playlistId}/Items`)
      removeUrl.searchParams.set('entryIds', toRemoveEntryIds.join(','))

      const removeResponse = await fetchUserAuthenticated(
        removeUrl.toString(),
        session.accessToken,
        {
          method: 'DELETE',
        },
      )

      if (!removeResponse.ok) {
        if (removeResponse.status === 401) {
          throw new Error('Authentication failed')
        }
        const text = await removeResponse.text()
        throw new Error(
          `Jellyfin returned ${removeResponse.status}: ${truncateText(text)}`,
        )
      }

      log.debug(
        `Removed ${toRemoveEntryIds.length} items from playlist ${playlistId}`,
      )
    }
  } catch (err) {
    log.error(`Failed to sync playlist items for ${playlistId}:`, err)
    throw err
  }
}

/**
 * Aktualisiert den Namen der Playlist, wenn er sich geändert hat.
 */
async function updatePlaylistName(
  session: JellyfinSession,
  playlistId: string,
  newName: string,
): Promise<void> {
  try {
    // Aktuelle Playlist lesen
    const getUrl = new URL(
      `${JELLYFIN_URL}/Users/${session.userId}/Items/${playlistId}`,
    )

    const getResponse = await fetchUserAuthenticated(
      getUrl.toString(),
      session.accessToken,
    )

    if (!getResponse.ok) {
      if (getResponse.status === 401) {
        throw new Error('Authentication failed')
      }
      const text = await getResponse.text()
      throw new Error(
        `Jellyfin returned ${getResponse.status}: ${truncateText(text)}`,
      )
    }

    const playlistData = (await getResponse.json()) as {
      Name?: string
      [key: string]: unknown
    }

    if (playlistData.Name === newName) {
      // Kein Update nötig
      return
    }

    // Name ändern
    playlistData.Name = newName

    const postUrl = new URL(`${JELLYFIN_URL}/Items/${playlistId}`)

    const postResponse = await fetchUserAuthenticated(
      postUrl.toString(),
      session.accessToken,
      {
        method: 'POST',
        body: JSON.stringify(playlistData),
        headers: {
          'content-type': 'application/json',
        },
      },
    )

    if (!postResponse.ok) {
      if (postResponse.status === 401) {
        throw new Error('Authentication failed')
      }
      const text = await postResponse.text()
      log.warning(
        `Failed to rename playlist ${playlistId}: ${postResponse.status}. Continuing anyway.`,
      )
      // Nicht abbrechen – der Inhalt ist wichtiger als der Name
      return
    }

    log.debug(`Renamed playlist ${playlistId} to "${newName}"`)
  } catch (err) {
    log.warning(`Failed to update playlist name for ${playlistId}:`, err)
    // Nicht abbrechen – der Inhalt ist wichtiger als der Name
  }
}

/**
 * Macht einen authentifizierten Fetch-Request als dieser Nutzer.
 */
async function fetchUserAuthenticated(
  url: string,
  accessToken: string,
  options?: RequestInit,
): Promise<Response> {
  const headers = new Headers(options?.headers ?? {})
  headers.set(
    'Authorization',
    `MediaBrowser Token="${accessToken}", Client="MovieMatch", Device="MovieMatch", DeviceId="moviematch", Version="${getVersion()}"`,
  )
  headers.set('accept', 'application/json')

  return fetch(url, {
    ...options,
    headers,
  })
}

/**
 * Kürzt Response-Text auf max. 500 Zeichen.
 */
function truncateText(text: string, maxLength: number = 500): string {
  if (text.length <= maxLength) {
    return text
  }
  return (
    text.substring(0, maxLength) +
    `... [truncated, ${text.length - maxLength} more chars]`
  )
}
