import { MovieMatchAPI } from './MovieMatchAPI.js'
import { CardView } from './CardView.js'
import { MatchesView } from './MatchesView.js'

const main = async () => {
  const CARD_STACK_SIZE = 4

  let api = new MovieMatchAPI()

  const { matches } = await login(api)

  let matchesView = new MatchesView(matches)
  let topCardEl

  // Undo history stack (stores movie objects that have been rated)
  const swipeHistory = []

  // Handle connection state changes
  let bannerCountdown = null

  const stopBannerCountdown = () => {
    if (bannerCountdown) {
      clearInterval(bannerCountdown)
      bannerCountdown = null
    }
  }

  api.addEventListener('connectionState', e => {
    const banner = document.querySelector('.js-connection-banner')
    if (!banner) return

    if (e.data === 'offline' || e.data === 'reconnecting') {
      // Der Countdown zeigt, wann der nächste Versuch anläuft, damit das
      // Banner nicht wie ein eingefrorener Zustand wirkt.
      const zeigeStatus = () => {
        const sekunden = api.secondsUntilRetry()
        banner.textContent =
          sekunden === null || sekunden <= 0
            ? document.body.dataset['i18nStatusOffline']
            : document.body.dataset['i18nStatusOfflineRetry'].replace(
                '$SECONDS',
                String(sekunden),
              )
      }

      zeigeStatus()
      banner.removeAttribute('hidden')
      stopBannerCountdown()
      bannerCountdown = setInterval(zeigeStatus, 1000)
    } else if (e.data === 'online') {
      stopBannerCountdown()
      banner.textContent = document.body.dataset['i18nStatusReconnected']
      banner.removeAttribute('hidden')
      // Hide banner after 2 seconds
      setTimeout(() => {
        banner.setAttribute('hidden', '')
      }, 2000)
    }
  })

  // Handle reconnection
  api.addEventListener('reconnected', e => {
    // Replace matches list with server's version
    matchesView.replaceMatches(e.data.matches || [])
  })

  api.addEventListener('match', e => matchesView.add(e.data))
  api.addEventListener('undoResponse', e => {
    if (e.data.success && swipeHistory.length > 0) {
      const movie = swipeHistory.pop()
      // Restore the card to the beginning of the stack
      new CardView(movie, cardStackEventTarget, true)
      topCardEl = document.querySelector('.js-card-stack > :first-child')

      // Re-enable rate controls if they were disabled
      const cardStackEl = document.querySelector('.js-card-stack')
      if (cardStackEl && rateControls.hasAttribute('disabled')) {
        rateControls.removeAttribute('disabled')
        cardStackEl.style.setProperty('--empty-text', `var(--i18n-loading)`)
      }

      updateUndoButtonState()
    }
  })
  api.addEventListener('matchRemoved', e => {
    matchesView.remove(e.data.guid)
  })

  const rateControls = document.querySelector('.rate-controls')
  const undoButton = document.querySelector('.js-undo-button')

  const updateUndoButtonState = () => {
    if (undoButton) {
      if (swipeHistory.length > 0) {
        undoButton.removeAttribute('disabled')
      } else {
        undoButton.setAttribute('disabled', '')
      }
    }
  }

  undoButton?.addEventListener('click', () => {
    api.undo()
  })

  rateControls.addEventListener('click', e => {
    let wantsToWatch
    if (e.target.classList.contains('rate-thumbs-down')) {
      wantsToWatch = false
    } else if (e.target.classList.contains('rate-thumbs-up')) {
      wantsToWatch = true
    } else {
      return
    }

    if (topCardEl) {
      topCardEl.dispatchEvent(new MessageEvent('rate', { data: wantsToWatch }))
    }
  })

  document.addEventListener('keydown', e => {
    const wantsToWatch =
      e.key === 'ArrowLeft' ? false : e.key === 'ArrowRight' ? true : null
    if (wantsToWatch === null) {
      return
    }
    if (topCardEl) {
      topCardEl.dispatchEvent(new MessageEvent('rate', { data: wantsToWatch }))
    }
  })

  const cardStackEventTarget = new EventTarget()

  cardStackEventTarget.addEventListener('newTopCard', () => {
    // Store the rated card in history before moving to the next card
    if (topCardEl && topCardEl.movieData) {
      swipeHistory.push(topCardEl.movieData)
      updateUndoButtonState()
    }

    topCardEl = topCardEl.nextSibling

    if (!topCardEl) {
      const cardStackEl = document.querySelector('.js-card-stack')

      if (cardStackEl) {
        cardStackEl.style.setProperty(
          '--empty-text',
          `var(--i18n-exhausted-cards)`,
        )
      }

      rateControls.setAttribute('disabled', '')
    }
  })

  for await (let [movie, i] of api) {
    if (i > CARD_STACK_SIZE) {
      const response = await new Promise(resolve => {
        cardStackEventTarget.addEventListener(
          'response',
          e => {
            resolve(e.data)
          },
          {
            once: true,
          },
        )
      })
      api.respond(response)
    } else if (i === CARD_STACK_SIZE) {
      topCardEl = document.querySelector('.js-card-stack > :first-child')
    }

    new CardView(movie, cardStackEventTarget)
  }
}

const authenticateWithJellyfin = async (name, password, createPlaylist) => {
  const basePath = document.body.dataset.basePath || ''

  let response
  try {
    response = await fetch(`${basePath}/api/jellyfin-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name, password, createPlaylist }),
    })
  } catch {
    throw new Error(document.body.dataset['i18nLoginErrorUnreachable'])
  }

  if (response.status === 429) {
    throw new Error(document.body.dataset['i18nLoginErrorRateLimited'])
  }

  if (!response.ok) {
    throw new Error(document.body.dataset['i18nLoginErrorCredentials'])
  }

  const result = await response.json()
  return result.playlistEnabled === true
}

export const login = async api => {
  const loginSection = document.querySelector('.login-section')
  const loginForm = document.querySelector('.js-login-form')
  const generateRoomCodeButton = document.querySelector(
    '.js-generate-room-code',
  )
  const passwordLabel = document.querySelector('.js-password-label')
  const passwordInput = document.querySelector('.js-password-input')
  const playlistLabel = document.querySelector('.js-playlist-label')
  const playlistCheckbox = document.querySelector('.js-playlist-checkbox')
  const roomCodeLine = document.querySelector('.js-room-code-line')
  const shareButton = document.querySelector('.js-share-button')
  const exportCsvLink = document.querySelector('.js-export-csv')
  const exportLikesLink = document.querySelector('.js-export-likes')
  const changeRoomButton = document.querySelector('.js-change-room')
  const userMenu = document.querySelector('.js-user-menu')
  const userMenuButton = document.querySelector('.js-user-menu-button')
  const userAvatar = document.querySelector('.js-user-avatar')
  const userInitials = document.querySelector('.js-user-initials')
  const userMenuDropdown = document.querySelector('.js-user-menu-dropdown')
  const logoutButton = document.querySelector('.js-logout-button')

  const isJellyfin = document.body.dataset.backend === 'jellyfin'

  // Show password field only if backend is Jellyfin
  if (isJellyfin) {
    passwordLabel?.removeAttribute('hidden')
    passwordInput?.removeAttribute('hidden')
    playlistLabel?.removeAttribute('hidden')
  }

  // Restore playlist checkbox state from localStorage
  if (playlistCheckbox) {
    const savedPlaylistState = localStorage.getItem('createPlaylist')
    if (savedPlaylistState === 'true') {
      playlistCheckbox.checked = true
    }
  }

  let user = localStorage.getItem('user')
  let roomCode = localStorage.getItem('roomCode')

  // Check for room code in URL query parameters
  const urlParams = new URLSearchParams(window.location.search)
  const urlRoomCode = urlParams.get('room')
  if (urlRoomCode) {
    const trimmedCode = urlRoomCode.trim().toUpperCase()
    if (/^[0-9A-Z]{4}$/.test(trimmedCode)) {
      roomCode = trimmedCode
    }
  }

  if (user) {
    loginForm.elements.name.value = user
  }

  if (roomCode) {
    loginForm.elements.roomCode.value = roomCode
  }

  // Set up input handler to keep roomCode uppercase
  const roomCodeInput = loginForm.elements.roomCode
  roomCodeInput.addEventListener('input', e => {
    const selStart = e.target.selectionStart
    const selEnd = e.target.selectionEnd
    e.target.value = e.target.value.toUpperCase()
    e.target.setSelectionRange(selStart, selEnd)
  })

  // Focus name field if room code came from URL and user is already set
  if (urlRoomCode && user) {
    loginForm.elements.name.focus()
  }

  generateRoomCodeButton.addEventListener('click', () => {
    const charMap = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const roomCode = Array.from({ length: 4 })
      .map(_ => charMap[Math.floor(Math.random() * charMap.length)])
      .join('')
    loginForm.elements.roomCode.value = roomCode
  })

  // Set up share button handler
  if (shareButton) {
    shareButton.addEventListener('click', async () => {
      const currentRoomCode = roomCodeLine.dataset.roomCode
      if (!currentRoomCode) {
        return
      }

      const shareUrl = new URL(window.location.href)
      shareUrl.hash = ''
      shareUrl.search = ''
      shareUrl.searchParams.set('room', currentRoomCode)

      try {
        // Try native share first
        if (navigator.share) {
          try {
            await navigator.share({
              title: 'MovieMatch',
              url: shareUrl.toString(),
            })
          } catch (err) {
            // User cancelled - silently ignore AbortError
            if (err.name !== 'AbortError') {
              throw err
            }
          }
        } else if (navigator.clipboard?.writeText) {
          // Try clipboard API
          await navigator.clipboard.writeText(shareUrl.toString())
          showShareCopiedFeedback()
        } else {
          // Fallback: create temporary input and use execCommand
          const textarea = document.createElement('textarea')
          textarea.value = shareUrl.toString()
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.select()
          document.execCommand('copy')
          document.body.removeChild(textarea)
          showShareCopiedFeedback()
        }
      } catch (err) {
        console.error('Failed to share link:', err)
      }
    })
  }

  function showShareCopiedFeedback() {
    const originalText = shareButton.textContent
    const copiedText = document.body.dataset['i18nShareCopied']
    shareButton.textContent = copiedText
    setTimeout(() => {
      shareButton.textContent = originalText
    }, 2000)
  }

  // Zurueck zum Anmeldeformular, um einen anderen Raum zu betreten.
  // Der Name und der Jellyfin-Sitzungscookie bleiben erhalten; nur der
  // Raum wird vergessen. Das Neuladen setzt den gesamten Zustand der
  // Oberflaeche (Kartenstapel, Trefferliste, Verlauf) sauber zurueck.
  if (changeRoomButton) {
    changeRoomButton.addEventListener('click', () => {
      localStorage.removeItem('roomCode')
      sessionStorage.setItem('skipAutoLogin', 'true')

      const target = new URL(window.location.href)
      target.search = ''
      target.hash = ''
      window.location.replace(target.toString())
    })
  }

  // Das Benutzermenue zeigt das Jellyfin-Profilbild. Ist keines hinterlegt,
  // antwortet der Server mit 404 und die Initiale bleibt stehen.
  const showUserMenu = userName => {
    if (!userMenu) {
      return
    }

    if (userInitials) {
      userInitials.textContent = userName.trim().charAt(0).toUpperCase()
    }

    if (userAvatar) {
      userAvatar.addEventListener(
        'load',
        () => {
          userAvatar.removeAttribute('hidden')
          userInitials?.setAttribute('hidden', '')
        },
        { once: true },
      )
      const basePath = document.body.dataset.basePath || ''
      userAvatar.src = `${basePath}/api/jellyfin-avatar`
    }

    userMenu.removeAttribute('hidden')
  }

  const closeUserMenu = () => {
    userMenuDropdown?.setAttribute('hidden', '')
    userMenuButton?.setAttribute('aria-expanded', 'false')
  }

  if (userMenuButton && userMenuDropdown) {
    userMenuButton.addEventListener('click', e => {
      // Sonst wuerde der Klick sofort wieder beim document ankommen und
      // das gerade geoeffnete Menue schliessen.
      e.stopPropagation()

      if (userMenuDropdown.hasAttribute('hidden')) {
        userMenuDropdown.removeAttribute('hidden')
        userMenuButton.setAttribute('aria-expanded', 'true')
      } else {
        closeUserMenu()
      }
    })

    document.addEventListener('click', closeUserMenu)
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeUserMenu()
      }
    })
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      const basePath = document.body.dataset.basePath || ''

      let response
      try {
        response = await fetch(`${basePath}/api/jellyfin-logout`, {
          method: 'POST',
          credentials: 'same-origin',
        })
      } catch {
        alert(document.body.dataset['i18nLoginErrorUnreachable'])
        return
      }

      if (!response.ok) {
        alert(document.body.dataset['i18nLoginErrorUnreachable'])
        return
      }

      // Name und Raum werden vergessen, damit auf einem geteilten Geraet
      // nichts von der vorherigen Person stehen bleibt.
      localStorage.removeItem('user')
      localStorage.removeItem('roomCode')
      sessionStorage.setItem('skipAutoLogin', 'true')

      const target = new URL(window.location.href)
      target.search = ''
      target.hash = ''
      window.location.replace(target.toString())
    })
  }

  return new Promise(resolve => {
    const handleSubmit = async e => {
      e.preventDefault()
      const formData = new FormData(loginForm)
      const name = formData.get('name')
      let roomCode = formData.get('roomCode')
      const password = formData.get('password') || ''
      const createPlaylist = formData.get('createPlaylist') === 'on'
      roomCode = roomCode.toUpperCase()
      if (name && roomCode) {
        try {
          // Bei gesetztem Passwort zuerst ueber den HTTP-Endpunkt anmelden.
          // Der Server setzt dabei den Sitzungs-Cookie, den die WebSocket-
          // Verbindung beim Aufbau mitschickt.
          let playlistEnabled = false
          if (isJellyfin && password) {
            playlistEnabled = await authenticateWithJellyfin(
              name,
              password,
              createPlaylist,
            )
            if (passwordInput) {
              passwordInput.value = ''
            }
            // Verbindung erneuern, damit der frische Cookie mitgeht.
            await api.restartConnection()
          }

          const data = await api.login(
            name,
            roomCode,
            playlistEnabled ? true : undefined,
          )
          loginForm.removeEventListener('submit', handleSubmit)

          await loginSection.animate(
            {
              opacity: ['1', '0'],
            },
            {
              duration: 250,
              easing: 'ease-in-out',
              fill: 'both',
            },
          ).finished

          loginSection.hidden = true
          localStorage.setItem('user', name)
          localStorage.setItem('roomCode', roomCode)

          // Save playlist checkbox state to localStorage
          if (createPlaylist) {
            localStorage.setItem('createPlaylist', 'true')
          } else {
            localStorage.removeItem('createPlaylist')
          }

          roomCodeLine.dataset.roomCode = roomCode

          // Das Benutzermenue erscheint nur bei bestaetigter Jellyfin-Anmeldung.
          if (data.jellyfinAuthenticated === true) {
            showUserMenu(name)
          }

          // Set CSV export link
          if (exportCsvLink) {
            const basePath = document.body.dataset.basePath || ''
            exportCsvLink.href = `${basePath}/api/rooms/${encodeURIComponent(
              roomCode,
            )}/matches.csv`
          }

          // Set likes export link
          if (exportLikesLink) {
            const basePath = document.body.dataset.basePath || ''
            exportLikesLink.href = `${basePath}/api/rooms/${encodeURIComponent(
              roomCode,
            )}/likes.csv?user=${encodeURIComponent(name)}`
          }

          document.body.scrollIntoView()

          await Promise.all(
            [
              ...document.querySelectorAll('.rate-section, .matches-section'),
            ].map(node => {
              node.hidden = false
              return node.animate(
                {
                  opacity: ['0', '1'],
                },
                {
                  duration: 250,
                  easing: 'ease-in-out',
                  fill: 'both',
                },
              ).finished
            }),
          )

          resolve({ ...data, user: name })
        } catch (err) {
          alert(err.message)
        }
      }
    }

    loginForm.addEventListener('submit', handleSubmit)

    // Nach einem Neuladen direkt in den zuletzt genutzten Raum zurueck.
    // Ein Passwort ist dabei nicht noetig: Die Jellyfin-Sitzung haengt am
    // Cookie, den der Server beim Verbindungsaufbau ausliest.
    const skipAutoLogin = sessionStorage.getItem('skipAutoLogin') === 'true'
    sessionStorage.removeItem('skipAutoLogin')

    // Zeigt die Adresszeile auf einen anderen Raum als den gespeicherten
    // (geteilter Link), bleibt das Formular stehen, damit der Name noch
    // angepasst werden kann.
    const roomMatchesUrl =
      !urlRoomCode || roomCode === localStorage.getItem('roomCode')

    if (!skipAutoLogin && user && roomCode && roomMatchesUrl) {
      loginForm.requestSubmit()
    }
  })
}

main().catch(err => console.error(err))
