import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer as WSServer } from 'ws'
import type { WebSocket as WSWebSocket } from 'ws'

export class WebSocketError extends Error {}

interface Options {
  onConnection: (ws: WebSocket) => void
  onError: (error: Error) => void
}

export class WebSocketServer {
  private wss: WSServer
  private options: Options
  private connections: Set<WebSocket> = new Set()

  constructor(options: Options) {
    this.options = options
    // Limit payload size to 64 KiB to protect against DoS attacks via oversized messages.
    // Legitimate messages (login, response, nextBatch) are much smaller.
    this.wss = new WSServer({ noServer: true, maxPayload: 64 * 1024 })
  }

  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    try {
      this.wss.handleUpgrade(request, socket, head, (ws: WSWebSocket) => {
        const webSocket = new WebSocket(ws, err => {
          this.options.onError(err)
        })
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
    for (const connection of this.connections) {
      connection.close()
    }
  }
}

export class WebSocket extends EventEmitter {
  private ws: WSWebSocket
  private _isClosed = false
  private onError: (err: Error) => void

  constructor(ws: WSWebSocket, onError: (err: Error) => void) {
    super()
    this.ws = ws
    this.onError = onError

    ws.on('message', (data: Buffer) => {
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

  get isClosed(): boolean {
    return this._isClosed
  }
}
