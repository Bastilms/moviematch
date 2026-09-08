const cardList = document.querySelector('.js-card-stack')

export class CardView {
  constructor(movieData, eventTarget, insertAtBeginning = false) {
    this.movieData = movieData
    this.eventTarget = eventTarget
    this.animationDuration = 500
    this.basePath = document.body.dataset.basePath
    this.render(insertAtBeginning)
  }

  render(insertAtBeginning = false) {
    const node = document.createElement('div')
    this.node = node
    node.classList.add('card')
    node.movieData = this.movieData
    node.addEventListener('pointerdown', this.handleSwipe)
    node.addEventListener('touchstart', e => e.preventDefault())
    node.addEventListener('rate', e =>
      this.rate(e.data, this.getAnimation(e.data ? 'right' : 'left')),
    )

    const { title, type, art, year, guid, summary, director, rating, key } =
      this.movieData
    node.dataset.guid = guid

    const srcSet = [
      `${this.basePath}${art}?w=300`,
      `${this.basePath}${art}?w=450 1.5x`,
      `${this.basePath}${art}?w=600 2x`,
      `${this.basePath}${art}?w=900 3x`,
    ]

    // Create card inner container
    const cardInner = document.createElement('div')
    cardInner.classList.add('card-inner')

    // Create front face
    const cardFront = document.createElement('div')
    cardFront.classList.add('card-face', 'card-front')

    // Create img element safely
    const img = document.createElement('img')
    img.classList.add('poster')
    img.src = srcSet[0]
    img.setAttribute('decode', 'async')
    img.setAttribute('srcset', srcSet.join(', '))
    img.alt = `${title} poster`
    cardFront.appendChild(img)

    // Create p element safely (title and year for front)
    const pFront = document.createElement('p')
    pFront.appendChild(document.createTextNode(title))
    if (type === 'movie') {
      pFront.appendChild(document.createTextNode(` (${year})`))
    }
    cardFront.appendChild(pFront)

    // Create back face
    const cardBack = document.createElement('div')
    cardBack.classList.add('card-face', 'card-back')

    // Title link on back
    const titleLink = document.createElement('a')
    titleLink.classList.add('card-back-title')
    titleLink.href = `${this.basePath}/movie/${encodeURIComponent(key)}`
    titleLink.setAttribute('target', '_blank')
    titleLink.setAttribute('rel', 'noopener noreferrer')
    titleLink.appendChild(document.createTextNode(title))
    cardBack.appendChild(titleLink)

    // Year and director (meta)
    const metaText = this.buildMetaText(year, director)
    if (metaText) {
      const pMeta = document.createElement('p')
      pMeta.classList.add('card-back-meta')
      pMeta.appendChild(document.createTextNode(metaText))
      cardBack.appendChild(pMeta)
    }

    // Summary
    const pSummary = document.createElement('p')
    pSummary.classList.add('card-back-summary')
    const summaryText =
      summary && summary.trim()
        ? summary
        : document.body.dataset['i18nNoSummary']
    pSummary.appendChild(document.createTextNode(summaryText))
    cardBack.appendChild(pSummary)

    // Rating
    if (rating) {
      const pRating = document.createElement('p')
      pRating.classList.add('card-back-rating')
      pRating.appendChild(document.createTextNode(`★ ${rating}`))
      cardBack.appendChild(pRating)
    }

    cardInner.appendChild(cardFront)
    cardInner.appendChild(cardBack)
    node.appendChild(cardInner)

    if (insertAtBeginning && cardList.firstChild) {
      cardList.insertBefore(node, cardList.firstChild)
    } else {
      cardList.appendChild(node)
    }
  }

  buildMetaText(year, director) {
    const parts = []
    if (year) {
      parts.push(String(year))
    }
    if (director) {
      parts.push(director)
    }
    return parts.length > 0 ? parts.join(' - ') : null
  }

  toggleFlip() {
    this.node.classList.toggle('is-flipped')
  }

  async rate(wantsToWatch, animation) {
    this.eventTarget.dispatchEvent(new Event('newTopCard'))

    if (animation.playState !== 'finished') {
      if (animation.currentTime === this.animationDuration) {
        animation.finish()
      } else {
        animation.playbackRate = 3
        animation.play()
      }
      await animation.finished
    }

    this.eventTarget.dispatchEvent(
      new MessageEvent('response', {
        data: {
          guid: this.movieData.guid,
          wantsToWatch,
        },
      }),
    )
    this.destroy()
  }

  isLinkTarget(element) {
    if (element instanceof HTMLAnchorElement) {
      return true
    }
    let parent = element.parentElement
    while (parent) {
      if (parent instanceof HTMLAnchorElement) {
        return true
      }
      parent = parent.parentElement
    }
    return false
  }

  handleSwipe = startEvent => {
    if (
      (startEvent.pointerType === 'mouse' && startEvent.button !== 0) ||
      startEvent.target instanceof HTMLButtonElement ||
      this.isLinkTarget(startEvent.target)
    ) {
      return
    }

    startEvent.preventDefault()
    this.node.setPointerCapture(startEvent.pointerId)

    // Store tap start info for tap detection
    this.tapStartTime = Date.now()
    this.tapStartX = startEvent.x
    this.tapStartY = startEvent.y
    // Initialize last pointer position to start position (for tap detection)
    this.lastPointerX = startEvent.x
    this.lastPointerY = startEvent.y

    const maxX = window.innerWidth

    let currentDirection
    let position = 0
    this.animationFrameRequestId = requestAnimationFrame(() =>
      this.animationLoop(),
    )

    const handleMove = e => {
      const direction = e.x < startEvent.x ? 'left' : 'right'
      const delta = e.x - startEvent.x

      // Store current pointer position for tap detection
      this.lastPointerX = e.x
      this.lastPointerY = e.y

      position =
        direction === 'left'
          ? Math.abs(delta) / startEvent.x
          : delta / (maxX - startEvent.x)

      if (currentDirection != direction) {
        currentDirection = direction
        // if (this.animation) {
        //   this.animation.finish()
        // }
        this.animation = this.getAnimation(direction)

        this.animation.pause()
      }

      this.currentTime =
        Math.max(0, Math.min(1, position)) * this.animationDuration
    }
    this.node.addEventListener('pointermove', handleMove, { passive: true })
    this.node.addEventListener(
      'lostpointercapture',
      async () => {
        this.node.removeEventListener('pointermove', handleMove)
        cancelAnimationFrame(this.animationFrameRequestId)

        // Detect tap vs swipe
        const now = Date.now()
        const duration = now - this.tapStartTime
        const dx = this.lastPointerX - this.tapStartX
        const dy = this.lastPointerY - this.tapStartY
        const distance = Math.sqrt(dx * dx + dy * dy)

        // Check if it's a tap (distance < 10px and duration < 300ms)
        if (distance < 10 && duration < 300) {
          this.toggleFlip()
          return
        }

        // Continue with swipe logic
        if (this.animation) {
          if (position >= 0.5) {
            await this.rate(currentDirection === 'right', this.animation)
          } else {
            this.animation.reverse()
          }

          this.animation = null
          currentDirection = null
        }
      },
      { once: true },
    )
  }

  animationLoop() {
    if (this.animation) {
      this.animation.currentTime = this.currentTime
    }
    this.animationFrameRequestId = requestAnimationFrame(() =>
      this.animationLoop(),
    )
  }

  getAnimation(direction) {
    return this.node.animate(
      {
        transform: [
          'translate(0, 0)',
          `translate(${direction === 'left' ? '-50vw' : '50vw'}, 0)`,
        ],
        opacity: ['1', '0.8', '0'],
      },
      {
        duration: this.animationDuration,
        easing: 'ease-in-out',
        fill: 'both',
      },
    )
  }

  destroy() {
    this.node.remove()
  }
}
