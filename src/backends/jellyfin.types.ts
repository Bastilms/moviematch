export interface JellyfinUser {
  Id: string
  Name: string
}

export interface JellyfinView {
  Id: string
  Name: string
  CollectionType: string
}

export interface JellyfinItemsResponse {
  Items: JellyfinItem[]
  TotalRecordCount: number
}

export interface JellyfinItem {
  Id: string
  Name: string
  Type: string
  Overview?: string
  CommunityRating?: number
  ProductionYear?: number
  ImageTags?: {
    Primary?: string
  }
  People?: Array<{
    Name: string
    Type: string
  }>
}

export interface JellyfinSystemInfo {
  Id: string
}
