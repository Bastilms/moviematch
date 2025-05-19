import axios from 'axios'
import { JELLYFIN_URL, JELLYFIN_API_KEY, JELLYFIN_LIBRARY_FILTER } from '../config.ts'

export async function getJellyfinMovies(userId: string) {
  // 1. Hole alle Libraries
  const librariesRes = await axios.get(`${JELLYFIN_URL}/Users/${userId}/Views`, {
    headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
  })
  const libraries = librariesRes.data.Items

  // 2. Filtere nach Library-Namen
  const filter = JELLYFIN_LIBRARY_FILTER.split(',').map(s => s.trim().toLowerCase())
  const filteredLibraries = libraries.filter(lib =>
    filter.includes(lib.Name.toLowerCase())
  )

  // 3. Hole alle Filme aus den gefilterten Libraries
  let allMovies: any[] = []
  for (const lib of filteredLibraries) {
    const res = await axios.get(`${JELLYFIN_URL}/Users/${userId}/Items`, {
      params: { IncludeItemTypes: 'Movie', ParentId: lib.Id },
      headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
    })
    allMovies = allMovies.concat(res.data.Items)
  }
  return allMovies
}