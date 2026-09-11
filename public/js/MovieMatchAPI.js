// Abstand zwischen zwei Lebenszeichen und Wartezeit auf die Antwort.
const HEARTBEAT_INTERVAL_MS = 20000
const PONG_TIMEOUT_MS = 10000

export class MovieMatchAPI extends EventTarget {
  constructor() {
    super()
    const basePath = location.pathname.replace(/\/(index\.html)?$/, '')
    this.basePath = basePath
    this.wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${
      location.host
    }${basePath}/ws`

    this._movieList = []
    this._isUnloading = false
    this._reconnectAttempts = 0
    this._messageQueue = []
    this._maxQueueSize = 200
    this._pendingBatchRequest = null
    this._lastLoginCredentials = null
    this._connectionState = 'offline'
    this._isFirstLogin = true
    this._heartbeatTimer = null
    this._pongTimer = null
    this._nextRetryAt = null
    this._reconnectTimer = null

    window.addEventListener('beforeunload', () => {
      this._isUnloading = true
      if (this.socket) {
        this.socket.close()
      }
    })

    this.connect()
  }

  connect() {
    if (this._isUnloading) return

    const socket = new WebSocket(this.wsUrl)
    this.socket = socket
    socket.addEventListener('message', e => this.handleMessage(e, socket))
    socket.addEventListener('open', () => this.handleOpen(socket))
    socket.addEventListener('close', () => this.handleClose(socket))
    socket.addEventListener('error', () => this.handleError(socket))
  }

  handleOpen(socket) {
    if (socket && socket !== this.socket) return

    // Steht eine Verbindung, ist ein noch geplanter Versuch hinfaellig.
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }

    // Nach einem Verbindungsverlust gilt die Lage erst dann als bereinigt,
    // wenn auch die Anmeldung wieder steht. Der Server kann die Anmeldung
    // noch ablehnen, solange er die alte, tote Verbindung haelt. Wuerde hier
    // schon "online" gemeldet, sprungen Banner und Wartezeit bei jedem
    // Versuch zurueck.
    if (!this._isFirstLogin && this._lastLoginCredentials) {
      this.dispatchEvent(new Event('connectionOpen'))
      this.performLogin()
      return
    }

    this._reconnectAttempts = 0
    this._nextRetryAt = null
    this.setConnectionState('online')
    this.dispatchEvent(new Event('connectionOpen'))
  }

  handleClose(socket) {
    if (socket && (socket !== this.socket || socket._abandoned)) return

    this.stopHeartbeat()

    if (!this._isUnloading) {
      this.setConnectionState('offline')
      this.scheduleReconnect()
    }
  }

  handleError(socket) {
    if (socket && (socket !== this.socket || socket._abandoned)) return

    this.stopHeartbeat()

    if (!this._isUnloading) {
      this.setConnectionState('offline')
      this.scheduleReconnect()
    }
  }

  scheduleReconnect() {
    if (this._isUnloading) return

    // Ein fehlgeschlagener Verbindungsaufbau meldet erst "error" und dann
    // "close". Ohne diese Sperre planen beide je einen Versuch, es liefen
    // also doppelt so viele wie vorgesehen — und der Countdown im Banner
    // wuerde bei jedem Planen zurueckspringen.
    if (this._reconnectTimer) return

    const delays = [1000, 2000, 4000, 8000, 15000]
    const delay = delays[Math.min(this._reconnectAttempts, delays.length - 1)]
    this._reconnectAttempts += 1

    this._nextRetryAt = Date.now() + delay

    this.setConnectionState('reconnecting')

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (!this._isUnloading) {
        this.connect()
      }
    }, delay)
  }

  /**
   * Sendet regelmäßig ein Lebenszeichen. Bleibt die Antwort aus, gilt die
   * Verbindung als tot und wird geschlossen, damit der Wiederaufbau anläuft.
   * Ohne diese Prüfung bleibt ein stiller Abbruch unbemerkt: Der Browser
   * feuert dann kein close-Ereignis.
   */
  startHeartbeat() {
    this.stopHeartbeat()

    this._heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return
      }

      this.socket.send(JSON.stringify({ type: 'ping' }))

      this._pongTimer = setTimeout(() => {
        // Keine Antwort: Die Verbindung ist tot, auch wenn der Browser das
        // noch nicht bemerkt hat.
        this.stopHeartbeat()
        this.abandonSocket()
      }, PONG_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer)
      this._pongTimer = null
    }
  }

  /**
   * Gibt die aktuelle Verbindung als verloren auf und stoesst den Wiederaufbau
   * an, ohne das close-Ereignis abzuwarten. Auf einer toten Leitung bestaetigt
   * die Gegenseite den Schliess-Rahmen nicht mehr; close() bliebe dann dauerhaft
   * im Zustand CLOSING haengen und das Ereignis kaeme nie.
   */
  abandonSocket() {
    const verloren = this.socket
    if (!verloren) {
      return
    }

    // Merkzeichen, damit ein spaeter doch noch eintreffendes close- oder
    // error-Ereignis dieser Verbindung keinen zweiten Wiederaufbau ausloest.
    verloren._abandoned = true

    try {
      verloren.close()
    } catch {
      // Bereits geschlossen; der Wiederaufbau laeuft trotzdem an.
    }

    if (!this._isUnloading) {
      this.setConnectionState('offline')
      this.scheduleReconnect()
    }
  }

  /**
   * Sekunden bis zum nächsten Verbindungsversuch, oder null wenn keiner
   * geplant ist. Die Oberfläche zeigt damit einen Countdown an.
   */
  secondsUntilRetry() {
    if (this._nextRetryAt === null) {
      return null
    }
    return Math.max(0, Math.ceil((this._nextRetryAt - Date.now()) / 1000))
  }

  /**
   * Baut die WebSocket-Verbindung neu auf. Der Sitzungs-Cookie wird vom
   * Server nur beim Verbindungsaufbau gelesen. Nach einer Anmeldung ueber
   * /api/jellyfin-login muss die Verbindung deshalb erneuert werden, damit
   * die Sitzung an der Verbindung haengt.
   */
  async restartConnection() {
    if (this._isUnloading) return

    const previous = this.socket
    this.connect()

    if (
      previous &&
      previous.readyState !== WebSocket.CLOSING &&
      previous.readyState !== WebSocket.CLOSED
    ) {
      previous.close()
    }

    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise(resolve =>
        this.addEventListener('connectionOpen', resolve, { once: true }),
      )
    }
  }

  setConnectionState(state) {
    if (this._connectionState !== state) {
      this._connectionState = state
      this.dispatchEvent(new MessageEvent('connectionState', { data: state }))
    }
  }

  async performLogin() {
    if (!this._lastLoginCredentials) return

    const { name, roomCode, createPlaylist } = this._lastLoginCredentials
    const payload = {
      name,
      roomCode,
    }

    if (createPlaylist === true) {
      payload.createPlaylist = true
    }

    this.socket.send(
      JSON.stringify({
        type: 'login',
        payload,
      }),
    )
  }

  flushMessageQueue() {
    while (
      this._messageQueue.length > 0 &&
      this.socket.readyState === WebSocket.OPEN
    ) {
      const message = this._messageQueue.shift()
      this.socket.send(message)
    }
  }

  async login(user, roomCode, createPlaylist) {
    // Store credentials for reconnection (without password)
    this._lastLoginCredentials = {
      name: user,
      roomCode,
      createPlaylist: createPlaylist === true,
    }

    const payload = {
      name: user,
      roomCode,
    }

    // Only include createPlaylist if it's explicitly set
    if (createPlaylist === true) {
      payload.createPlaylist = true
    }

    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise(resolve =>
        this.addEventListener('connectionOpen', resolve, { once: true }),
      )
    }

    this.socket.send(
      JSON.stringify({
        type: 'login',
        payload,
      }),
    )

    return new Promise((resolve, reject) => {
      this.addEventListener(
        'loginResponse',
        e => {
          if (e.data.success) {
            resolve(e.data)
          } else {
            const reason = e.data.reason || `${user} is already logged in.`
            this._lastLoginCredentials = null
            reject(new Error(reason))
          }
        },
        { once: true },
      )
    })
  }

  handleMessage(e, socket) {
    if (socket && socket !== this.socket) return

    const data = JSON.parse(e.data)
    const isReconnection =
      this._connectionState === 'reconnecting' || this._lastLoginCredentials

    switch (data.type) {
      case 'batch': {
        this.dispatchEvent(new MessageEvent('batch', { data: data.payload }))
        this._movieList.push(...data.payload)
        this._pendingBatchRequest = null
        this.flushMessageQueue()
        break
      }
      case 'pong': {
        // Die Verbindung lebt.
        if (this._pongTimer) {
          clearTimeout(this._pongTimer)
          this._pongTimer = null
        }
        break
      }
      case 'match': {
        return this.dispatchEvent(
          new MessageEvent('match', { data: data.payload }),
        )
      }
      case 'loginResponse': {
        this._movieList = data.payload.movies ?? []

        if (data.payload.success) {
          // Erst ab jetzt beantwortet der Server Lebenszeichen.
          this.startHeartbeat()
          if (this._isFirstLogin) {
            // This is the initial login
            this._isFirstLogin = false
            this.dispatchEvent(
              new MessageEvent('loginResponse', { data: data.payload }),
            )
          } else {
            // This is a reconnection login
            // Jetzt erst ist der Verbindungsverlust wirklich ueberstanden.
            this._reconnectAttempts = 0
            this._nextRetryAt = null
            this.setConnectionState('online')
            this.dispatchEvent(
              new MessageEvent('reconnected', { data: data.payload }),
            )
            // Flush queued messages
            this.flushMessageQueue()
            // Resend pending batch request if any
            if (this._pendingBatchRequest) {
              this.socket.send(
                JSON.stringify({
                  type: 'nextBatch',
                }),
              )
            }
          }
        } else if (this._isFirstLogin) {
          // Die erste Anmeldung wurde abgewiesen. Das ist eine echte Absage
          // an den Nutzer (Name belegt, Eingabe falsch) und wird angezeigt.
          this._lastLoginCredentials = null
          this.dispatchEvent(
            new MessageEvent('loginResponse', { data: data.payload }),
          )
        } else {
          // Waehrend eines Wiederaufbaus: Der Server haelt womoeglich noch die
          // alte, tote Verbindung und weist deshalb mit "is already logged in"
          // ab. Das gibt sich, sobald sein Herzschlag sie wegraeumt. Also
          // nicht aufgeben, sondern spaeter erneut versuchen.
          this.stopHeartbeat()
          this.abandonSocket()
        }
        break
      }
      case 'undoResponse': {
        this.dispatchEvent(
          new MessageEvent('undoResponse', { data: data.payload }),
        )
        break
      }
      case 'matchRemoved': {
        this.dispatchEvent(
          new MessageEvent('matchRemoved', { data: data.payload }),
        )
        break
      }
    }
  }

  respond({ guid, wantsToWatch }) {
    const message = JSON.stringify({
      type: 'response',
      payload: {
        guid,
        wantsToWatch,
      },
    })

    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message)
    } else {
      this._messageQueue.push(message)
      if (this._messageQueue.length > this._maxQueueSize) {
        this._messageQueue.shift()
      }
    }
  }

  async requestNextBatch() {
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise(resolve =>
        this.addEventListener('connectionOpen', resolve, { once: true }),
      )
    }

    this._pendingBatchRequest = true
    this.socket.send(
      JSON.stringify({
        type: 'nextBatch',
      }),
    )
    return new Promise(resolve =>
      this.addEventListener('batch', e => resolve(e.data), { once: true }),
    )
  }

  undo() {
    const message = JSON.stringify({
      type: 'undo',
    })

    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message)
    } else {
      this._messageQueue.push(message)
      if (this._messageQueue.length > this._maxQueueSize) {
        this._messageQueue.shift()
      }
    }
  }

  getMovie(guid) {
    return this._movieList.find(_ => _.guid === guid)
  }

  [Symbol.asyncIterator]() {
    this.movieListIndex = 0
    return {
      next: async () => {
        if (!this._movieList[this.movieListIndex]) {
          const batch = await this.requestNextBatch()
          if (batch.length === 0) {
            return { done: true }
          }
        }

        const value = [
          this._movieList[this.movieListIndex],
          this.movieListIndex,
        ]
        this.movieListIndex += 1
        return {
          value,
          done: false,
        }
      },
    }
  }
}
