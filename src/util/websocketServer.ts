import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer as WSServer } from 'ws'
import type { WebSocket as WSWebSocket } from 'ws'
import { getClientIp } from './rateLimit.js'
import type { JellyfinSession } from './jellyfinUser.js'

export class WebSocketError extends Error {}

// Alle 30 Sekunden wird geprüft, ob die Gegenstellen noch antworten. Ohne
// diese Prüfung bleiben nach einem stillen Verbindungsabbruch halboffene
// Verbindungen stehen; ein Wiederanmelden desselben Namens wird dann mit
// "is already logged in" abgewiesen.
const HEARTBEAT_INTERVAL = 30 * 1000

interface Options {
  onConnection: (ws: WebSocket) => void
  onError: (error: Error) => void
  messageRateLimiter?: (ip: string) => boolean
  trustProxy?: boolean
}

export class WebSocketServer {
  private wss: WSServer
  private options: Options
  private connections: Set<WebSocket> = new Set()
  private messageRateLimiterFn?: (ip: string) => boolean
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(options: Options) {
    this.options = options
    this.messageRateLimiterFn = options.messageRateLimiter
    // Limit payload size to 64 KiB to protect against DoS attacks via oversized messages.
    // Legitimate messages (login, response, nextBatch) are much smaller.
    this.wss = new WSServer({ noServer: true, maxPayload: 64 * 1024 })

    this.heartbeatTimer = setInterval(() => {
      for (const connection of this.connections) {
        if (!connection.isAlive) {
          // Auf den vorigen Ping kam keine Antwort.
          connection.terminate()
          continue
        }
        connection.isAlive = false
        connection.ping()
      }
    }, HEARTBEAT_INTERVAL)

    // Der Zeitgeber soll den Prozess nicht am Leben halten.
    this.heartbeatTimer.unref()
  }

  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      this.wss.handleUpgrade(request, socket, head, (ws: WSWebSocket) => {
        const webSocket = new WebSocket(ws, err => {
          this.options.onError(err)
        })
        // Store the request so we can extract the IP later if needed
        webSocket._request = request
        // Extract and store the client IP
        webSocket.remoteAddress = getClientIp(
          request,
          this.options.trustProxy ?? false,
        )
        // Attach the message rate limiter function
        webSocket._messageRateLimiter = this.messageRateLimiterFn
        // Attach the Jellyfin session from the request, if available
        if ((request as any)._jellyfinSession) {
          webSocket.jellyfin = (request as any)._jellyfinSession
        }
        this.connections.add(webSocket)
        webSocket.once('close', () => {
          this.connections.delete(webSocket)
        })
        this.options.onConnection(webSocket)
      })
    } catch (err) {
      this.options.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  closeAll(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const connection of this.connections) {
      connection.close()
    }
  }
}

export interface StoredJellyfinSession {
  userId: string
  userName: string
  accessToken: string | null
}

export class WebSocket extends EventEmitter {
  private ws: WSWebSocket
  private _isClosed = false
  private onError: (err: Error) => void
  public _request?: IncomingMessage
  public remoteAddress?: string
  public _messageRateLimiter?: (ip: string) => boolean
  public jellyfin: StoredJellyfinSession | null = null
  public playlistEnabled: boolean = false
  public playlistId: string | null = null
  public isAlive: boolean = true

  constructor(ws: WSWebSocket, onError: (err: Error) => void) {
    super()
    this.ws = ws
    this.onError = onError

    ws.on('message', (data: Buffer) => {
      // Check message rate limit if available
      if (this._messageRateLimiter && this.remoteAddress) {
        if (!this._messageRateLimiter(this.remoteAddress)) {
          // Rate limit exceeded: silently discard the message
          return
        }
      }

      // Convert Buffer to UTF-8 string
      const message = data.toString('utf-8')
      this.emit('message', message)
    })

    ws.on('close', () => {
      this._isClosed = true
      this.emit('close')
    })

    ws.on('error', (err: Error) => {
      // Handle error without emitting unhandled error event
      this.onError(err)
      this._isClosed = true
      try {
        this.ws.close()
      } catch {}
    })

    ws.on('ping', (data: Buffer) => {
      this.emit('ping', data)
    })

    ws.on('pong', (data: Buffer) => {
      // Die Gegenseite hat geantwortet, die Verbindung lebt noch.
      this.isAlive = true
      this.emit('pong', data)
    })
  }

  send(message: string | Uint8Array): void {
    if (this._isClosed) {
      throw new WebSocketError('WebSocket is closed')
    }
    this.ws.send(message)
  }

  close(code?: number, reason?: string): void {
    if (this._isClosed) {
      return
    }
    this._isClosed = true
    this.ws.close(code, reason)
  }

  ping(): void {
    if (this._isClosed) {
      return
    }
    try {
      this.ws.ping()
    } catch {
      // Eine Verbindung, die sich nicht mehr anpingen lässt, ist ohnehin tot.
    }
  }

  terminate(): void {
    this.ws.terminate()
  }

  get isClosed(): boolean {
    return this._isClosed
  }
}
