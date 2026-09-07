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
}
