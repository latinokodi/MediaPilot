import { create } from 'zustand'

export interface TMDBItem {
  id: number
  title: string
  overview: string
  poster: string | null
  backdrop: string | null
  year: string
  rating: number
  media_type: string
  imdb_id?: string
  runtime?: number
  genres?: string[]
  seasons?: SeasonInfo[]
}

export interface SeasonInfo {
  season_number: number
  name: string
  episode_count: number
  poster: string | null
}

export interface EpisodeInfo {
  episode_number: number
  name: string
  overview: string
  still: string | null
  air_date: string
}

export interface TMDBCollections {
  movies?: { key: string; label: string; count?: number; poster?: string | null }[]
  tv?: { key: string; label: string; count?: number; poster?: string | null }[]
}

export interface TMDBLists {
  movies: Record<string, TMDBItem[]>
  tv: Record<string, TMDBItem[]>
  collections?: TMDBCollections
}

export interface DiscoverResult {
  title: string
  size: string
  seeders: number
  peers: number
  link: string
  indexer: string
  info_hash: string | null
  provider?: string
}

// Latino providers always float to the top of the results list
const LATINO_PROVIDERS = new Set(['TCL', 'Cinecalidad', 'Comet'])

interface DiscoverState {
  // TMDB lists
  lists: TMDBLists | null
  listsLoading: boolean
  listsError: string | null

  // Browse state
  listType: string
  mediaTab: 'movies' | 'tv'

  // Detail view
  detailItem: TMDBItem | null
  detailLoading: boolean

  // Series picker
  selectedSeason: SeasonInfo | null
  episodes: EpisodeInfo[] | null
  episodesLoading: boolean
  selectedEpisode: EpisodeInfo | null

  // Provider search
  providerResults: DiscoverResult[] | null
  providerLoading: boolean
  currentProvider: string | null

  // Has TMDB key configured
  hasKey: boolean

  // Actions
  setLists: (lists: TMDBLists) => void
  setListsError: (error: string) => void
  setListType: (type: string) => void
  setMediaTab: (tab: 'movies' | 'tv') => void
  setDetailItem: (item: TMDBItem | null) => void
  setDetailLoading: (loading: boolean) => void
  setSelectedSeason: (season: SeasonInfo | null) => void
  setEpisodes: (episodes: EpisodeInfo[] | null) => void
  setSelectedEpisode: (ep: EpisodeInfo | null) => void
  appendProviderResults: (results: DiscoverResult[]) => void
  setCurrentProvider: (provider: string | null) => void
  setProviderLoading: (loading: boolean) => void
  clearProviderSearch: () => void
  setHasKey: (has: boolean) => void
  reset: () => void
}

export const useDiscoverStore = create<DiscoverState>((set, get) => ({
  lists: null,
  listsLoading: false,
  listsError: null,
  listType: 'trending',
  mediaTab: 'movies',
  detailItem: null,
  detailLoading: false,
  selectedSeason: null,
  episodes: null,
  episodesLoading: false,
  selectedEpisode: null,
  providerResults: null,
  providerLoading: false,
  currentProvider: null,
  hasKey: false,

  setLists: (lists) => set({ lists, listsLoading: false, listsError: null }),
  setListsError: (error) => set({ listsError: error, listsLoading: false }),
  setListType: (listType) => set({ listType }),
  setMediaTab: (mediaTab) => set({ mediaTab }),
  setDetailItem: (item) => set({ detailItem: item, detailLoading: false }),
  setDetailLoading: (loading) => set({ detailLoading: loading }),
  setSelectedSeason: (season) => set({
    selectedSeason: season,
    episodes: null,
    selectedEpisode: null,
    providerResults: null,
    episodesLoading: !!season,
  }),
  setEpisodes: (episodes) => set({ episodes, episodesLoading: false }),
  setSelectedEpisode: (ep) => set({ selectedEpisode: ep, providerResults: null, providerLoading: false }),

  appendProviderResults: (newResults) => {
    const existing = get().providerResults ?? []
    const seen = new Map<string, DiscoverResult>()
    for (const r of existing) {
      const key = r.info_hash || r.link || ''
      if (key) seen.set(key, r)
    }
    for (const r of newResults) {
      const key = r.info_hash || r.link || ''
      if (!key) continue
      const old = seen.get(key)
      if (!old || r.seeders > old.seeders) {
        seen.set(key, r)
      }
    }
    set({ providerResults: [...seen.values()].sort((a, b) => {
      // Latino providers first, then by seeders within each group
      const aLat = LATINO_PROVIDERS.has(a.provider || '') ? 0 : 1
      const bLat = LATINO_PROVIDERS.has(b.provider || '') ? 0 : 1
      if (aLat !== bLat) return aLat - bLat
      return b.seeders - a.seeders
    }) })
  },

  setCurrentProvider: (provider) => set({ currentProvider: provider }),
  setProviderLoading: (loading) => set({ providerLoading: loading }),
  clearProviderSearch: () => set({
    detailItem: null,
    selectedSeason: null,
    episodes: null,
    selectedEpisode: null,
    providerResults: null,
    providerLoading: false,
    currentProvider: null,
  }),
  setHasKey: (has) => set({ hasKey: has }),
  reset: () => set({
    detailItem: null,
    selectedSeason: null,
    episodes: null,
    selectedEpisode: null,
    providerResults: null,
    providerLoading: false,
    currentProvider: null,
  }),
}))
