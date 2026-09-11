import { randomBytes } from 'node:crypto'
import * as log from './logger.js'
import { SESSION_TTL_HOURS } from '../config.js'
import { logoutJellyfinUser } from './jellyfinUser.js'
import type { StoredJellyfinSession } from './websocketServer.js'

export interface StoredSession extends StoredJellyfinSession {
  createdAt: number
}

interface SessionEntry {
  session: StoredSession
  id: string
}

const sessions = new Map<string, SessionEntry>()
const CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 Minuten
const MAX_SESSIONS = 1000
const TTL_MILLISECONDS = SESSION_TTL_HOURS * 60 * 60 * 1000

let cleanupTimer: NodeJS.Timeout | null = null

/**
 * Startet den Cleanup-Zeitgeber, wenn noch nicht geschehen.
 */
function ensureCleanupTimer(): void {
  if (cleanupTimer) {
    return
  }

  cleanupTimer = setInterval(() => {
    cleanupExpiredSessions()
  }, CLEANUP_INTERVAL)

  // use unref() so the timer doesn't keep the process alive
  cleanupTimer.unref()
}

/**
 * Entfernt abgelaufene Sitzungen und beendet deren Jellyfin-Anmeldung.
 */
function cleanupExpiredSessions(): void {
  const now = Date.now()
  const idsToDelete: string[] = []

  for (const [id, entry] of sessions.entries()) {
    if (now - entry.session.createdAt > TTL_MILLISECONDS) {
      idsToDelete.push(id)
    }
  }

  for (const id of idsToDelete) {
    const entry = sessions.get(id)
    if (entry && entry.session.accessToken) {
      // Jellyfin-Anmeldung beenden
      logoutJellyfinUser(entry.session.accessToken).catch(err => {
        log.debug(`Failed to logout Jellyfin user during cleanup: ${err}`)
      })
    }
    sessions.delete(id)
  }
}

/**
 * Erzeugt eine Sitzung und gibt die Kennung zurück.
 */
export function createSession(session: StoredSession): string {
  // Starte den Cleanup-Zeitgeber, wenn nötig
  ensureCleanupTimer()

  // Erzeuge eine zufällige Kennung
  const id = randomBytes(32).toString('hex')

  // Prüfe die harte Obergrenze
  if (sessions.size >= MAX_SESSIONS) {
    // Versuche zuerst, abgelaufene Sitzungen zu entfernen
    cleanupExpiredSessions()

    // Wenn noch zu viele Sitzungen vorhanden sind, entferne die älteste
    if (sessions.size >= MAX_SESSIONS) {
      let oldestId = ''
      let oldestTime = Infinity

      for (const [entryId, entry] of sessions.entries()) {
        if (entry.session.createdAt < oldestTime) {
          oldestTime = entry.session.createdAt
          oldestId = entryId
        }
      }

      if (oldestId) {
        const oldEntry = sessions.get(oldestId)
        if (oldEntry && oldEntry.session.accessToken) {
          logoutJellyfinUser(oldEntry.session.accessToken).catch(err => {
            log.debug(
              `Failed to logout Jellyfin user during limit enforcement: ${err}`,
            )
          })
        }
        sessions.delete(oldestId)
      }
    }
  }

  sessions.set(id, { session, id })
  return id
}

/**
 * Ruft die Sitzung ab, sofern vorhanden und nicht abgelaufen.
 * Abgelaufene Sitzungen werden entfernt.
 */
export function getSession(id: string): StoredSession | null {
  const entry = sessions.get(id)
  if (!entry) {
    return null
  }

  const now = Date.now()
  if (now - entry.session.createdAt > TTL_MILLISECONDS) {
    // Sitzung ist abgelaufen – entfernen
    if (entry.session.accessToken) {
      logoutJellyfinUser(entry.session.accessToken).catch(err => {
        log.debug(`Failed to logout Jellyfin user during expiration: ${err}`)
      })
    }
    sessions.delete(id)
    return null
  }

  return entry.session
}

/**
 * Entfernt die Sitzung und beendet die Jellyfin-Anmeldung.
 */
export function destroySession(id: string): void {
  const entry = sessions.get(id)
  if (!entry) {
    return
  }

  if (entry.session.accessToken) {
    logoutJellyfinUser(entry.session.accessToken).catch(err => {
      log.debug(`Failed to logout Jellyfin user during destroy: ${err}`)
    })
  }

  sessions.delete(id)
}

/**
 * Beendet den Aufräum-Zeitgeber (für geordnetes Herunterfahren).
 */
export function stopSessionStore(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}

/**
 * Gibt die Anzahl der aktuellen Sitzungen zurück (für Tests und Diagnose).
 */
export function sessionCount(): number {
  return sessions.size
}
