import { JELLYFIN_URL, JELLYFIN_API_KEY, getVersion } from '../config.js'
import * as log from './logger.js'

/**
 * Jellyfin-Kennungen sind 32-stelliges Hex oder eine GUID mit Bindestrichen.
 * Werte aus Antworten des Medienservers landen in ausgehenden URL-Pfaden und
 * werden deshalb geprueft, bevor sie eingesetzt werden.
 */
const JELLYFIN_ID_REGEX =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export function assertJellyfinId(id: string, context: string): void {
  if (typeof id !== 'string' || !JELLYFIN_ID_REGEX.test(id)) {
    throw new Error(`Jellyfin returned an unexpected ${context}.`)
  }
}

export interface JellyfinSession {
  userId: string
  userName: string
  accessToken: string
}

/**
 * Authenticates a user against a Jellyfin server.
 * Returns the user ID, user name, and access token on success.
 * Throws an Error with a user-friendly message on failure.
 * The password is never logged or stored; only the access token is registered for redaction.
 */
export async function authenticateJellyfinUser(
  username: string,
  password: string,
): Promise<JellyfinSession> {
  const url = new URL(`${JELLYFIN_URL}/Users/AuthenticateByName`)

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    Authorization: `MediaBrowser Client="MovieMatch", Device="MovieMatch", DeviceId="moviematch", Version="${getVersion()}"`,
  }

  const body = {
    Username: username,
    Pw: password,
  }

  let response: Response
  try {
    response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } catch (err) {
    log.error('Failed to reach Jellyfin authentication endpoint:', err)
    throw new Error('Jellyfin login failed.')
  }

  // 401 Unauthorized - bad credentials
  if (response.status === 401) {
    throw new Error('Invalid Jellyfin credentials.')
  }

  // Any other error status
  if (!response.ok) {
    let responseText = ''
    try {
      responseText = await response.text()
    } catch {
      responseText = '<unable to read response>'
    }
    const truncated =
      responseText.length > 500
        ? responseText.substring(0, 500) +
          `... [truncated, ${responseText.length - 500} more chars]`
        : responseText
    log.error(
      `Jellyfin /Users/AuthenticateByName returned ${response.status}: ${truncated}`,
    )
    throw new Error('Jellyfin login failed.')
  }

  let data: unknown
  try {
    data = await response.json()
  } catch (err) {
    log.error('Failed to parse Jellyfin authentication response:', err)
    throw new Error('Jellyfin login failed.')
  }

  // Validate response structure
  if (
    typeof data !== 'object' ||
    data === null ||
    !('AccessToken' in data) ||
    !('User' in data)
  ) {
    log.error('Jellyfin authentication response missing required fields')
    throw new Error('Jellyfin login failed.')
  }

  const responseData = data as Record<string, unknown>
  const accessToken = responseData.AccessToken
  const user = responseData.User

  if (typeof accessToken !== 'string' || !accessToken) {
    log.error('Jellyfin authentication response has invalid AccessToken')
    throw new Error('Jellyfin login failed.')
  }

  if (
    typeof user !== 'object' ||
    user === null ||
    !('Id' in user) ||
    !('Name' in user)
  ) {
    log.error('Jellyfin authentication response has invalid User object')
    throw new Error('Jellyfin login failed.')
  }

  const userData = user as Record<string, unknown>
  const userId = userData.Id
  const userName = userData.Name

  if (typeof userId !== 'string' || !userId) {
    log.error('Jellyfin authentication response has invalid User.Id')
    throw new Error('Jellyfin login failed.')
  }

  if (typeof userName !== 'string' || !userName) {
    log.error('Jellyfin authentication response has invalid User.Name')
    throw new Error('Jellyfin login failed.')
  }

  // Register the access token for redaction from logs
  if (accessToken.length >= 8) {
    log.addRedactedValue(accessToken)
  }

  log.debug(`Jellyfin user ${userId} authenticated successfully`)

  return {
    userId,
    userName,
    accessToken,
  }
}

/**
 * Beendet die Jellyfin-Anmeldung zu diesem Zugriffstoken.
 * Fehler werden geschluckt.
 */
export async function logoutJellyfinUser(accessToken: string): Promise<void> {
  const url = new URL(`${JELLYFIN_URL}/Sessions/Logout`)

  const headers = {
    Authorization: `MediaBrowser Token="${accessToken}", Client="MovieMatch", Device="MovieMatch", DeviceId="moviematch", Version="${getVersion()}"`,
  }

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
    })

    if (!response.ok) {
      log.debug(`Failed to logout Jellyfin session: HTTP ${response.status}`)
    }
  } catch (err) {
    log.debug(`Failed to reach Jellyfin logout endpoint: ${err}`)
  }
}

export interface JellyfinAvatar {
  body: Uint8Array
  contentType: string
}

/**
 * Laedt das Profilbild eines Jellyfin-Benutzers ueber den Zugriffsschluessel
 * des Servers. Gibt null zurueck, wenn kein Bild hinterlegt ist, der
 * Medienserver nicht antwortet oder etwas anderes als ein Bild zurueckkommt.
 */
export async function fetchJellyfinAvatar(
  userId: string,
  maxHeight: number,
): Promise<JellyfinAvatar | null> {
  // Die Kennung stammt aus der Sitzung und wird unten in einen URL-Pfad
  // eingesetzt. Deshalb vorher streng pruefen.
  assertJellyfinId(userId, 'user id')

  const url = new URL(`${JELLYFIN_URL}/Users/${userId}/Images/Primary`)
  url.searchParams.set('maxHeight', String(maxHeight))

  const headers = {
    accept: 'image/*',
    Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}", Client="MovieMatch", Device="MovieMatch", DeviceId="moviematch", Version="${getVersion()}"`,
  }

  let response: Response
  try {
    response = await fetch(url.toString(), { headers })
  } catch (err) {
    log.debug(`Failed to reach Jellyfin avatar endpoint: ${err}`)
    return null
  }

  if (!response.ok) {
    // 404 ist der Normalfall fuer Benutzer ohne Profilbild.
    log.debug(`Jellyfin avatar request returned ${response.status}`)
    return null
  }

  // Nur Rasterbilder weiterreichen. "image/svg+xml" beginnt ebenfalls mit
  // "image/", ist aber ein XML-Dokument, das Skripte enthalten kann.
  const ALLOWED_IMAGE_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
  ]

  const contentType = response.headers.get('content-type') ?? ''
  // Der Medienserver haengt mitunter Angaben wie "; charset=utf-8" an.
  const baseContentType = contentType.split(';')[0].trim().toLowerCase()

  if (!ALLOWED_IMAGE_TYPES.includes(baseContentType)) {
    log.debug(`Jellyfin avatar has unexpected content type: ${contentType}`)
    return null
  }

  const buffer = await response.arrayBuffer()

  // Obergrenze, damit ein fehlerhafter oder boesartiger Medienserver den
  // Arbeitsspeicher nicht mit einer riesigen Antwort belasten kann.
  const MAX_AVATAR_BYTES = 2 * 1024 * 1024
  if (buffer.byteLength > MAX_AVATAR_BYTES) {
    log.debug(`Jellyfin avatar too large: ${buffer.byteLength} bytes`)
    return null
  }

  return {
    body: new Uint8Array(buffer),
    contentType: baseContentType,
  }
}
