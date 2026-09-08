import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DATABASE_PATH } from '../config.js'
import type { MediaItem } from '../backends/types.js'

let instance: DatabaseSync | null = null

/**
 * Initialize the database on startup. This checks that the database directory
 * is writable and creates the schema if needed.
 * Throws an error with a detailed message if initialization fails.
 */
export function initDatabase(): void {
  const resolvedPath = resolve(DATABASE_PATH)
  const dbDir = dirname(resolvedPath)

  // Get process UID and GID (available on Unix-like systems)
  let uidGidInfo = ''
  if (
    typeof process.getuid === 'function' &&
    typeof process.getgid === 'function'
  ) {
    const uid = process.getuid()
    const gid = process.getgid()
    uidGidInfo = ` (running as UID ${uid}, GID ${gid})`
  }

  // Try to create the directory
  try {
    mkdirSync(dbDir, { recursive: true })
  } catch (err) {
    const systemError = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to create database directory.\n` +
        `Database path: ${resolvedPath}\n` +
        `Directory: ${dbDir}${uidGidInfo}\n\n` +
        `If you mounted a host directory into the container, make sure it is writable.\n` +
        `Example fix: mkdir -p ./data && sudo chown -R 1000:1000 ./data\n\n` +
        `Alternatively, set DATABASE_PATH to a writable location.\n\n` +
        `System error: ${systemError}`
    )
  }

  // Try to open/create the database and set up schema
  try {
    instance = new DatabaseSync(resolvedPath)

    // Set PRAGMAs
    instance.exec('PRAGMA journal_mode = WAL')
    instance.exec('PRAGMA foreign_keys = ON')

    // Create schema
    instance.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media (
        guid TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        year TEXT NOT NULL DEFAULT '',
        art TEXT NOT NULL DEFAULT '',
        director TEXT,
        rating TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(room_code, name)
      );

      CREATE TABLE IF NOT EXISTS room_media (
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        media_guid TEXT NOT NULL REFERENCES media(guid) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (room_code, media_guid)
      );

      CREATE INDEX IF NOT EXISTS idx_room_media_position
        ON room_media(room_code, position);

      CREATE TABLE IF NOT EXISTS swipes (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        media_guid TEXT NOT NULL REFERENCES media(guid) ON DELETE CASCADE,
        wants_to_watch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, media_guid)
      );
    `)
  } catch (err) {
    const systemError = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to initialize database.\n` +
        `Database path: ${resolvedPath}\n` +
        `Directory: ${dbDir}${uidGidInfo}\n\n` +
        `If you mounted a host directory into the container, make sure it is writable.\n` +
        `Example fix: mkdir -p ./data && sudo chown -R 1000:1000 ./data\n\n` +
        `Alternatively, set DATABASE_PATH to a writable location.\n\n` +
        `System error: ${systemError}`
    )
  }
}

export function getDatabase(): DatabaseSync {
  if (instance) {
    return instance
  }

  // Create directory if it doesn't exist (fallback for backward compatibility)
  mkdirSync(dirname(DATABASE_PATH), { recursive: true })

  // Open database
  instance = new DatabaseSync(DATABASE_PATH)

  // Set PRAGMAs
  instance.exec('PRAGMA journal_mode = WAL')
  instance.exec('PRAGMA foreign_keys = ON')

  // Create schema
  instance.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media (
      guid TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      year TEXT NOT NULL DEFAULT '',
      art TEXT NOT NULL DEFAULT '',
      director TEXT,
      rating TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(room_code, name)
    );

    CREATE TABLE IF NOT EXISTS room_media (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      media_guid TEXT NOT NULL REFERENCES media(guid) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (room_code, media_guid)
    );

    CREATE INDEX IF NOT EXISTS idx_room_media_position
      ON room_media(room_code, position);

    CREATE TABLE IF NOT EXISTS swipes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_guid TEXT NOT NULL REFERENCES media(guid) ON DELETE CASCADE,
      wants_to_watch INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, media_guid)
    );
  `)

  return instance
}

export function closeDatabase(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}

export function ensureRoom(roomCode: string): void {
  const db = getDatabase()
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO rooms (code, created_at) VALUES (?, ?)'
  )
  stmt.run(roomCode, Date.now())
}

export function getOrCreateUser(
  roomCode: string,
  name: string
): { id: number; name: string } {
  const db = getDatabase()

  // First try to get existing user
  const getStmt = db.prepare(
    'SELECT id, name FROM users WHERE room_code = ? AND name = ?'
  )
  const existing = getStmt.get(roomCode, name) as
    | { id: number; name: string }
    | undefined

  if (existing) {
    return existing
  }

  // Create new user
  const insertStmt = db.prepare(
    'INSERT INTO users (room_code, name, created_at) VALUES (?, ?, ?)'
  )
  insertStmt.run(roomCode, name, Date.now())

  // Get the inserted user
  const getNewStmt = db.prepare(
    'SELECT id, name FROM users WHERE room_code = ? AND name = ?'
  )
  return getNewStmt.get(roomCode, name) as { id: number; name: string }
}

export function upsertMedia(items: MediaItem[]): void {
  const db = getDatabase()
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO media
    (guid, title, summary, year, art, director, rating, key, type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const item of items) {
    // Defensively convert all values to ensure they can be bound to SQLite parameters
    stmt.run(
      // guid: ensure it's a non-empty string (required)
      String(item.guid || ''),
      // title: ensure it's a string
      String(item.title || ''),
      // summary: ensure it's a string
      String(item.summary || ''),
      // year: ensure it's a string
      String(item.year || ''),
      // art: ensure it's a string
      String(item.art || ''),
      // director: null for undefined/null, otherwise string
      item.director == null ? null : String(item.director),
      // rating: ensure it's a string
      String(item.rating || ''),
      // key: ensure it's a string
      String(item.key || ''),
      // type: pass through (should be 'movie' or 'show')
      item.type
    )
  }
}

export function getRoomMedia(roomCode: string): MediaItem[] {
  const db = getDatabase()
  const stmt = db.prepare(`
    SELECT m.* FROM media m
    JOIN room_media rm ON m.guid = rm.media_guid
    WHERE rm.room_code = ?
    ORDER BY rm.position ASC
  `)

  const rows = stmt.all(roomCode) as Array<
    Omit<MediaItem, 'director'> & { director: string | null }
  >

  return rows.map(row => ({
    ...row,
    director: row.director ?? undefined,
  }))
}

export function getRoomMediaGuids(roomCode: string): Set<string> {
  const db = getDatabase()
  const stmt = db.prepare(
    'SELECT media_guid FROM room_media WHERE room_code = ?'
  )

  const rows = stmt.all(roomCode) as Array<{ media_guid: string }>
  return new Set(rows.map(row => row.media_guid))
}

export function addRoomMedia(roomCode: string, items: MediaItem[]): void {
  const db = getDatabase()

  db.exec('BEGIN TRANSACTION')
  try {
    // Upsert all media first
    upsertMedia(items)

    // Get max position for this room
    const maxStmt = db.prepare(
      'SELECT MAX(position) as max_pos FROM room_media WHERE room_code = ?'
    )
    const result = maxStmt.get(roomCode) as { max_pos: number | null }
    let position = (result.max_pos ?? -1) + 1

    // Insert room_media entries
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO room_media (room_code, media_guid, position)
      VALUES (?, ?, ?)
    `)

    for (const item of items) {
      insertStmt.run(roomCode, item.guid, position)
      position++
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function recordSwipe(
  userId: number,
  mediaGuid: string,
  wantsToWatch: boolean
): boolean {
  const db = getDatabase()
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO swipes (user_id, media_guid, wants_to_watch, created_at)
    VALUES (?, ?, ?, ?)
  `)

  const result = stmt.run(userId, mediaGuid, wantsToWatch ? 1 : 0, Date.now())

  // If changes is 0, it means the row already existed (conflict ignored)
  return result.changes > 0
}

export function getUserSwipedGuids(userId: number): Set<string> {
  const db = getDatabase()
  const stmt = db.prepare('SELECT media_guid FROM swipes WHERE user_id = ?')

  const rows = stmt.all(userId) as Array<{ media_guid: string }>
  return new Set(rows.map(row => row.media_guid))
}

export function getUserLikedGuids(userId: number): Set<string> {
  const db = getDatabase()
  const stmt = db.prepare(
    'SELECT media_guid FROM swipes WHERE user_id = ? AND wants_to_watch = 1'
  )

  const rows = stmt.all(userId) as Array<{ media_guid: string }>
  return new Set(rows.map(row => row.media_guid))
}

export function getLikersForMedia(
  roomCode: string,
  mediaGuid: string
): string[] {
  const db = getDatabase()
  const stmt = db.prepare(`
    SELECT DISTINCT u.name FROM users u
    JOIN swipes s ON u.id = s.user_id
    WHERE u.room_code = ? AND s.media_guid = ? AND s.wants_to_watch = 1
    ORDER BY u.name ASC
  `)

  const rows = stmt.all(roomCode, mediaGuid) as Array<{ name: string }>
  return rows.map(row => row.name)
}

export function roomExists(roomCode: string): boolean {
  const db = getDatabase()
  const stmt = db.prepare('SELECT 1 FROM rooms WHERE code = ? LIMIT 1')
  const result = stmt.get(roomCode) as { '1': number } | undefined
  return result !== undefined
}

export function getRoomMatches(
  roomCode: string
): Array<{ movie: MediaItem; users: string[] }> {
  const db = getDatabase()

  // Get all media in this room with their likers
  const stmt = db.prepare(`
    SELECT
      m.guid,
      m.title,
      m.summary,
      m.year,
      m.art,
      m.director,
      m.rating,
      m.key,
      m.type,
      COUNT(DISTINCT s.user_id) as liker_count
    FROM media m
    JOIN room_media rm ON m.guid = rm.media_guid
    LEFT JOIN swipes s ON m.guid = s.media_guid
      AND s.user_id IN (SELECT id FROM users WHERE room_code = ?)
      AND s.wants_to_watch = 1
    WHERE rm.room_code = ?
    GROUP BY m.guid
    HAVING liker_count >= 2
    ORDER BY liker_count DESC, m.title ASC
  `)

  const rows = stmt.all(roomCode, roomCode) as Array<
    Omit<MediaItem, 'director'> & { director: string | null }
  >

  return rows.map(row => ({
    movie: {
      guid: row.guid,
      title: row.title,
      summary: row.summary,
      year: row.year,
      art: row.art,
      director: row.director ?? undefined,
      rating: row.rating,
      key: row.key,
      type: row.type,
    },
    users: getLikersForMedia(roomCode, row.guid),
  }))
}
