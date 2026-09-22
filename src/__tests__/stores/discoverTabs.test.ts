import { describe, it, expect, beforeEach } from 'vitest'
import { useDiscoverStore, type DiscoverResult, type TMDBItem } from '../../store/discoverTabs'

function makeResult(overrides: Partial<DiscoverResult> = {}): DiscoverResult {
  return {
    title: 'Test Movie 2024',
    size: '2.1 GB',
    seeders: 100,
    peers: 50,
    link: 'magnet:?xt=urn:btih:abc123',
    indexer: 'testprovider',
    info_hash: 'abc123',
    ...overrides,
  }
}

function makeTMDBItem(overrides: Partial<TMDBItem> = {}): TMDBItem {
  return {
    id: 12345,
    title: 'Test Movie',
    overview: 'A test movie',
    poster: null,
    backdrop: null,
    year: '2024',
    rating: 7.5,
    media_type: 'movie',
    ...overrides,
  }
}

describe('discoverStore', () => {
  beforeEach(() => {
    useDiscoverStore.getState().reset()
    useDiscoverStore.setState({
      lists: null,
      listsLoading: false,
      listsError: null,
      listType: 'trending',
      mediaTab: 'movies',
      hasKey: false,
    })
  })

  describe('setLists', () => {
    it('sets lists and clears loading/error', () => {
      useDiscoverStore.setState({ listsLoading: true, listsError: 'prev error' })
      useDiscoverStore.getState().setLists({
        movies: { trending: [makeTMDBItem()] },
        tv: { trending: [] },
      })
      const state = useDiscoverStore.getState()
      expect(state.lists).toBeDefined()
      expect(state.lists!.movies.trending).toHaveLength(1)
      expect(state.listsLoading).toBe(false)
      expect(state.listsError).toBeNull()
    })
  })

  describe('setSelectedSeason', () => {
    it('clears episodes, selectedEpisode, and providerResults on new season', () => {
      const store = useDiscoverStore
      // Simulate previous state
      store.setState({
        episodes: [{ episode_number: 1, name: 'E1', overview: '', still: null, air_date: '' }],
        selectedEpisode: { episode_number: 1, name: 'E1', overview: '', still: null, air_date: '' },
        providerResults: [makeResult()],
      })

      store.getState().setSelectedSeason({ season_number: 2, name: 'S2', episode_count: 10, poster: null })

      const state = store.getState()
      expect(state.selectedSeason?.season_number).toBe(2)
      expect(state.episodes).toBeNull()
      expect(state.selectedEpisode).toBeNull()
      expect(state.providerResults).toBeNull()
      expect(state.episodesLoading).toBe(true)
    })
  })

  describe('appendProviderResults', () => {
    it('adds results sorted by seeders descending', () => {
      useDiscoverStore.getState().appendProviderResults([
        makeResult({ seeders: 10 }),
        makeResult({ info_hash: 'def', seeders: 50 }),
      ])
      const state = useDiscoverStore.getState()
      expect(state.providerResults).toHaveLength(2)
      expect(state.providerResults![0].seeders).toBe(50)
      expect(state.providerResults![1].seeders).toBe(10)
    })

    it('deduplicates by info_hash keeping highest seeders', () => {
      useDiscoverStore.getState().appendProviderResults([
        makeResult({ info_hash: 'abc', seeders: 10 }),
      ])
      useDiscoverStore.getState().appendProviderResults([
        makeResult({ info_hash: 'abc', seeders: 100 }),
      ])
      const state = useDiscoverStore.getState()
      expect(state.providerResults).toHaveLength(1)
      expect(state.providerResults![0].seeders).toBe(100)
    })
  })

  describe('clearProviderSearch', () => {
    it('resets detail, season, episode, and results', () => {
      const store = useDiscoverStore
      store.setState({
        detailItem: makeTMDBItem(),
        selectedSeason: { season_number: 1, name: 'S1', episode_count: 8, poster: null },
        episodes: [{ episode_number: 1, name: 'E1', overview: '', still: null, air_date: '' }],
        selectedEpisode: { episode_number: 1, name: 'E1', overview: '', still: null, air_date: '' },
        providerResults: [makeResult()],
        providerLoading: true,
        currentProvider: 'test',
      })

      store.getState().clearProviderSearch()

      const state = store.getState()
      expect(state.detailItem).toBeNull()
      expect(state.selectedSeason).toBeNull()
      expect(state.episodes).toBeNull()
      expect(state.selectedEpisode).toBeNull()
      expect(state.providerResults).toBeNull()
      expect(state.providerLoading).toBe(false)
      expect(state.currentProvider).toBeNull()
    })
  })

  describe('reset', () => {
    it('clears search state but preserves browse state', () => {
      const store = useDiscoverStore
      store.setState({
        lists: { movies: { trending: [makeTMDBItem()] }, tv: { trending: [] } },
        listType: 'popular',
        mediaTab: 'tv',
        hasKey: true,
        detailItem: makeTMDBItem(),
        providerResults: [makeResult()],
      })

      store.getState().reset()

      const state = store.getState()
      // Browse state preserved
      expect(state.lists).toBeDefined()
      expect(state.listType).toBe('popular')
      expect(state.mediaTab).toBe('tv')
      expect(state.hasKey).toBe(true)
      // Search state cleared
      expect(state.detailItem).toBeNull()
      expect(state.providerResults).toBeNull()
      expect(state.currentProvider).toBeNull()
    })
  })
})
