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

export const login = async api => {
  const loginSection = document.querySelector('.login-section')
  const loginForm = document.querySelector('.js-login-form')
  const generateRoomCodeButton = document.querySelector(
    '.js-generate-room-code',
  )
  const roomCodeLine = document.querySelector('.js-room-code-line')
  const shareButton = document.querySelector('.js-share-button')
  const exportCsvLink = document.querySelector('.js-export-csv')

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

  return new Promise(resolve => {
    const handleSubmit = async e => {
      e.preventDefault()
      const formData = new FormData(loginForm)
      const name = formData.get('name')
      const roomCode = formData.get('roomCode')
      if (name && roomCode) {
        try {
          const data = await api.login(name, roomCode)
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

          roomCodeLine.dataset.roomCode = roomCode

          // Set CSV export link
          if (exportCsvLink) {
            const basePath = document.body.dataset.basePath || ''
            exportCsvLink.href = `${basePath}/api/rooms/${encodeURIComponent(
              roomCode,
            )}/matches.csv`
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
  })
}

main().catch(err => console.error(err))
