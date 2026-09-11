export class MatchesView {
  constructor(matches = []) {
    this.matches = matches
    this.node = document.querySelector('.js-matches-section')
    this.matchesCountEl = this.node.querySelector('.js-matches-count')
    this.matchesListEl = this.node.querySelector('.js-matches-list')
    this.render()
  }

  add(match) {
    const existingIndex = this.matches.findIndex(
      _ => _.movie.guid === match.movie.guid,
    )

    if (existingIndex !== -1) {
      this.matches.splice(existingIndex, 1)
    }

    this.matchesCountEl.animate(
      {
        transform: ['scale(1)', 'scale(1.5)', 'scale(1)'],
      },
      {
        duration: 300,
        easing: 'ease-in-out',
        fill: 'both',
      },
    )

    this.matches.push(match)
    this.render()
  }

  remove(guid) {
    const index = this.matches.findIndex(_ => _.movie.guid === guid)
    if (index !== -1) {
      this.matches.splice(index, 1)
      this.render()
    }
  }

  replaceMatches(newMatches) {
    this.matches = newMatches || []
    this.render()
  }

  formatList = users => {
    if (users.length < 3) return users.join(' and ')

    const items = [...users]
    const last = items.splice(-1)
    return `${items.join(', ')}, ${
      document.body.dataset.i18nListConjunction
    } ${last}`
  }

  render() {
    this.matchesCountEl.dataset.count = this.matches.length

    this.matches.sort((a, b) => b.users.length - a.users.length)

    // Clear existing matches
    this.matchesListEl.innerHTML = ''

    // Create list items using DOM methods to prevent XSS
    for (const { users, movie } of this.matches) {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.classList.add('card')
      a.href = `${document.body.dataset.basePath}/movie/${encodeURIComponent(
        movie.key,
      )}`
      a.target = this.node.dataset.targetType

      const img = document.createElement('img')
      img.classList.add('poster')
      img.src = `${document.body.dataset.basePath}${movie.art}`
      img.alt = `${movie.title} poster`

      a.appendChild(img)

      // Safely insert the template with user names and movie title
      const p = document.createElement('p')
      const template = document.body.dataset.i18nMatchLikersTemplate
      const usersList = this.formatList(users)

      // Split template on placeholders and create text nodes
      // Template format: "$USERS want to watch $MOVIE" or similar
      const parts = template.split('$USERS')
      if (parts.length === 2) {
        const beforeUsers = parts[0]
        const afterUsers = parts[1]

        if (beforeUsers) {
          p.appendChild(document.createTextNode(beforeUsers))
        }
        p.appendChild(document.createTextNode(usersList))

        const afterUsersParts = afterUsers.split('$MOVIE')
        if (afterUsersParts.length === 2) {
          if (afterUsersParts[0]) {
            p.appendChild(document.createTextNode(afterUsersParts[0]))
          }
          p.appendChild(document.createTextNode(movie.title))
          if (afterUsersParts[1]) {
            p.appendChild(document.createTextNode(afterUsersParts[1]))
          }
        } else {
          p.appendChild(document.createTextNode(afterUsers))
        }
      } else {
        p.appendChild(document.createTextNode(template))
      }

      a.appendChild(p)
      li.appendChild(a)
      this.matchesListEl.appendChild(li)
    }
  }
}
