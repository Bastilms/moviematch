export type MediaType = 'movie' | 'artist' | 'photo' | 'show'
export type LinkType = 'app' | 'http' | 'plex.tv'

export interface MediaItem {
  guid: string
  title: string
  summary: string
  year: string
  art: string
  director?: string
  rating: string
  key: string
  type: MediaType
}

export interface Poster {
  body: Uint8Array
  contentType: string
}

export interface MediaBackend {
  readonly name: 'plex' | 'jellyfin'
  getMediaItems(): Promise<MediaItem[]>
  getPoster(posterKey: string, width: number): Promise<Poster>
  getDeepLink(key: string, linkType: LinkType): Promise<string>
  /**
   * Ergänzt für eine kleine Auswahl von Titeln nachträglich Angaben, die beim
   * Laden des gesamten Katalogs zu teuer wären. Wird vor dem Ausliefern eines
   * Kartenstapels aufgerufen. Backends, die alle Angaben ohnehin mitliefern,
   * lassen die Methode weg.
   */
  enrichItems?(items: MediaItem[]): Promise<void>
}
