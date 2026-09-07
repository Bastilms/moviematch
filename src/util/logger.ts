const LogLevels = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
}

const LevelNames = {
  0: 'DEBUG',
  1: 'INFO',
  2: 'WARNING',
  3: 'ERROR',
  4: 'CRITICAL',
} as Record<number, string>

let currentLevel = LogLevels.INFO

// Set of values to redact from logs (e.g., API keys, tokens)
const redactedValues = new Set<string>()

export function setLevel(level: string): void {
  const upper = level.toUpperCase()
  if (!(upper in LogLevels)) {
    const validLevels = Object.keys(LogLevels)
    throw new Error(
      `${level} is not a recognised log level. Please use one of these: ${validLevels.join(
        ', '
      )}`
    )
  }
  currentLevel = LogLevels[upper as keyof typeof LogLevels]
}

/**
 * Register a value to be redacted from all log output.
 * Useful for API keys, tokens, and other secrets.
 */
export function addRedactedValue(value: string): void {
  if (value && value.length > 0) {
    redactedValues.add(value)
  }
}

/**
 * Redact registered secrets from text, plus patterns like query parameters.
 * Also handles Error objects by processing their message and stack properties.
 */
function redact(value: unknown): string {
  let text: string

  if (value instanceof Error) {
    // For Error objects, redact both message and stack
    const message = value.message ? redactSecrets(value.message) : ''
    const stack = value.stack ? redactSecrets(value.stack) : ''
    text = stack || message
  } else if (typeof value === 'string') {
    text = redactSecrets(value)
  } else if (value === undefined) {
    text = 'undefined'
  } else if (value === null) {
    text = 'null'
  } else {
    text = String(value)
    text = redactSecrets(text)
  }

  return text
}

/**
 * Replace registered secrets and known patterns in text.
 */
function redactSecrets(text: string): string {
  let result = text

  // Replace all registered secret values with ***
  for (const secret of redactedValues) {
    if (secret.length > 0) {
      // Use global regex to replace all occurrences
      const regex = new RegExp(escapeRegex(secret), 'g')
      result = result.replace(regex, '***')
    }
  }

  // Additionally, mask X-Plex-Token query parameter pattern
  // Matches: X-Plex-Token=<anything until & or end of string or whitespace>
  result = result.replace(/X-Plex-Token=[^&\s]*/g, 'X-Plex-Token=***')

  return result
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function log(level: number, ...args: unknown[]): void {
  if (level < currentLevel) {
    return
  }
  const timestamp = new Date().toISOString()
  const levelName = LevelNames[level]
  // Redact all arguments before logging
  const redactedArgs = args.map(redact)
  console.log(`${timestamp} ${levelName}`, ...redactedArgs)
}

export function debug(...args: unknown[]): void {
  log(LogLevels.DEBUG, ...args)
}

export function info(...args: unknown[]): void {
  log(LogLevels.INFO, ...args)
}

export function warning(...args: unknown[]): void {
  log(LogLevels.WARNING, ...args)
}

export function error(...args: unknown[]): void {
  log(LogLevels.ERROR, ...args)
}

export function critical(...args: unknown[]): void {
  log(LogLevels.CRITICAL, ...args)
}
