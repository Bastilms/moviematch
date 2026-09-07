import type { IncomingMessage } from 'node:http'

/**
 * Rate limiter interface for IP-based request limiting
 */
export interface RateLimiter {
  /**
   * Check if a request from the given IP is allowed.
   * Returns true if allowed, false if limit is exceeded.
   */
  check(ip: string): boolean

  /**
   * Get the number of IPs currently being tracked
   */
  size(): number

  /**
   * Stop the rate limiter and clean up timers
   */
  stop(): void

  /**
   * Set the logger function to report when IPs are throttled
   */
  setLogger?(logger: (limitType: string, ip: string) => void): void
}

interface Entry {
  count: number
  lastCleanup: number
}

/**
 * Create a rate limiter that allows a specified number of requests per minute per IP.
 * Uses a sliding window approach: each request increments a counter.
 * Entries are cleaned up periodically.
 *
 * @param limitPerMinute Maximum number of requests per IP per minute
 * @returns A rate limiter instance
 */
export function createRateLimiter(limitPerMinute: number): RateLimiter {
  const map = new Map<string, Entry>()
  const CLEANUP_INTERVAL = 30_000 // 30 seconds
  const WINDOW_SIZE = 60_000 // 1 minute in milliseconds
  const MAX_TRACKED_IPS = 10_000
  const MAX_REPORTED_IPS = 1_000 // Limit on the size of the reported set

  // Track which IPs have already been reported as throttled
  const reportedIps = new Set<string>()

  let loggerFn: ((limitType: string, ip: string) => void) | null = null

  // Set up periodic cleanup of expired entries
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    const ipsToDelete: string[] = []

    for (const [ip, entry] of map.entries()) {
      if (now - entry.lastCleanup > WINDOW_SIZE) {
        ipsToDelete.push(ip)
        // When cleaning up an IP's entry, also remove it from reported set
        // so we log again if it gets throttled later
        reportedIps.delete(ip)
      }
    }

    for (const ip of ipsToDelete) {
      map.delete(ip)
    }

    // Clean up reported set if it gets too large
    if (reportedIps.size > MAX_REPORTED_IPS) {
      reportedIps.clear()
    }
  }, CLEANUP_INTERVAL)

  // Use unref so this timer doesn't keep the process alive
  cleanupTimer.unref()

  return {
    check(ip: string): boolean {
      const now = Date.now()

      // If we've hit the hard limit and this IP is new, try cleanup
      if (map.size >= MAX_TRACKED_IPS && !map.has(ip)) {
        // Run one cleanup pass to make room
        const ipsToDelete: string[] = []
        for (const [trackedIp, entry] of map.entries()) {
          if (now - entry.lastCleanup > WINDOW_SIZE) {
            ipsToDelete.push(trackedIp)
          }
        }
        for (const trackedIp of ipsToDelete) {
          map.delete(trackedIp)
        }

        // If still at limit, deny
        if (map.size >= MAX_TRACKED_IPS) {
          return false
        }
      }

      // Get or create entry for this IP
      let entry = map.get(ip)
      if (!entry) {
        entry = { count: 0, lastCleanup: now }
        map.set(ip, entry)
      }

      // Check if window has expired
      if (now - entry.lastCleanup > WINDOW_SIZE) {
        entry.count = 0
        entry.lastCleanup = now
        // IP's window reset, so remove it from reported set if it was there
        reportedIps.delete(ip)
      }

      // Check limit
      if (entry.count >= limitPerMinute) {
        // Log only on first rejection for this IP (transition to throttled state)
        if (!reportedIps.has(ip) && loggerFn) {
          loggerFn('', ip)
          reportedIps.add(ip)
        }
        return false
      }

      // Increment and allow
      entry.count++
      return true
    },

    size(): number {
      return map.size
    },

    stop(): void {
      clearInterval(cleanupTimer)
    },

    setLogger(logger: (limitType: string, ip: string) => void): void {
      loggerFn = logger
    },
  }
}

/**
 * Determine the client's IP address from an HTTP request.
 *
 * - If TRUST_PROXY is false (default), uses req.socket.remoteAddress
 * - If TRUST_PROXY is true, uses the first entry of the X-Forwarded-For header
 * - IPv4-in-IPv6 addresses are normalized (e.g., ::ffff:1.2.3.4 → 1.2.3.4)
 * - Returns 'unknown' if no IP can be determined
 *
 * **IMPORTANT:** TRUST_PROXY should only be true when MovieMatch runs behind
 * a trusted reverse proxy (nginx, HAProxy, etc.). Otherwise, clients can
 * spoof X-Forwarded-For to bypass rate limits. When true, each rate limit
 * contention is per origin IP. When false, all clients behind the proxy
 * share the same limit.
 */
export function getClientIp(req: IncomingMessage, trustProxy: boolean): string {
  // If we trust proxy headers, check X-Forwarded-For first
  if (trustProxy) {
    const xForwardedFor = req.headers['x-forwarded-for']
    if (typeof xForwardedFor === 'string') {
      // Take the first IP in the list and trim
      const firstIp = xForwardedFor.split(',')[0].trim()
      if (firstIp) {
        return normalizeIpv6(firstIp)
      }
    } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
      const firstIp = xForwardedFor[0].trim()
      if (firstIp) {
        return normalizeIpv6(firstIp)
      }
    }
  }

  // Fall back to socket address
  const remoteAddress = req.socket.remoteAddress
  if (remoteAddress) {
    return normalizeIpv6(remoteAddress)
  }

  // If all else fails
  return 'unknown'
}

/**
 * Normalize IPv4-in-IPv6 addresses (::ffff:1.2.3.4 → 1.2.3.4)
 */
function normalizeIpv6(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    return ip.slice('::ffff:'.length)
  }
  return ip
}
