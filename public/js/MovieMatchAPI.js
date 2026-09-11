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
    this._maxReconnectAttempts = Infinity
    this._messageQueue = []
    this._maxQueueSize = 200
    this._pendingBatchRequest = null
    this._lastLoginCredentials = null
    this._connectionState = 'offline'
    this._isFirstLogin = true

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

    this.socket = new WebSocket(this.wsUrl)
    this.socket.addEventListener('message', e => this.handleMessage(e))
    this.socket.addEventListener('open', () => this.handleOpen())
    this.socket.addEventListener('close', () => this.handleClose())
    this.socket.addEventListener('error', () => this.handleError())
  }

  handleOpen() {
    this._reconnectAttempts = 0
    this.setConnectionState('online')
    this.dispatchEvent(new Event('connectionOpen'))

    // Perform auto-login on reconnection (but not on initial connection)
    if (!this._isFirstLogin && this._lastLoginCredentials) {
      this.performLogin()
    }
  }

  handleClose() {
    if (!this._isUnloading) {
      this.setConnectionState('offline')
      this.scheduleReconnect()
    }
  }

  handleError() {
    if (!this._isUnloading) {
      this.setConnectionState('offline')
      this.scheduleReconnect()
    }
  }

  scheduleReconnect() {
    if (this._isUnloading) return

    const delays = [1000, 2000, 4000, 8000, 15000]
    const delay = delays[Math.min(this._reconnectAttempts, delays.length - 1)]
    this._reconnectAttempts += 1

    this.setConnectionState('reconnecting')

    setTimeout(() => {
      if (!this._isUnloading) {
        this.connect()
      }
    }, delay)
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

  async login(user, roomCode, password, createPlaylist) {
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

    // Only include password if it's provided and non-empty
    if (password) {
      payload.password = password
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
            this._maxReconnectAttempts = 0
            reject(new Error(reason))
          }
        },
        { once: true },
      )
    })
  }

  handleMessage(e) {
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
      case 'match': {
        return this.dispatchEvent(
          new MessageEvent('match', { data: data.payload }),
        )
      }
      case 'loginResponse': {
        this._movieList = data.payload.movies ?? []

        if (data.payload.success) {
          if (this._isFirstLogin) {
            // This is the initial login
            this._isFirstLogin = false
            this.dispatchEvent(
              new MessageEvent('loginResponse', { data: data.payload }),
            )
          } else {
            // This is a reconnection login
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
        } else {
          // Login failed
          this._lastLoginCredentials = null
          this._maxReconnectAttempts = 0
          this.dispatchEvent(
            new MessageEvent('loginResponse', { data: data.payload }),
          )
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
