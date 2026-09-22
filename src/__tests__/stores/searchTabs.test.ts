import { describe, it, expect, beforeEach } from 'vitest'
import { useSearchTabsStore, type SearchResult } from '../../store/searchTabs'

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Test Movie 2024',
    size: '2.1 GB',
    seeders: 100,
    peers: 50,
    link: 'magnet:?xt=urn:btih:abc123',
    indexer: 'testengine',
    info_hash: 'abc123',
    ...overrides,
  }
}

describe('searchTabsStore', () => {
  beforeEach(() => {
    useSearchTabsStore.setState({
      tabs: {},
      activeTabId: null,
      counter: 0,
    })
  })

  describe('addTab', () => {
    it('creates a tab and sets it as active', () => {
      const id = useSearchTabsStore.getState().addTab('ubuntu 24.04')
      const state = useSearchTabsStore.getState()

      expect(state.activeTabId).toBe(id)
      expect(state.tabs[id]).toBeDefined()
      expect(state.tabs[id].query).toBe('ubuntu 24.04')
      expect(state.tabs[id].loading).toBe(true)
      expect(state.tabs[id].results).toBeNull()
      expect(state.tabs[id].error).toBeNull()
    })

    it('increments counter for unique tab IDs', () => {
      const id1 = useSearchTabsStore.getState().addTab('query1')
      const id2 = useSearchTabsStore.getState().addTab('query2')
      expect(id1).toBe('1')
      expect(id2).toBe('2')
      expect(Object.keys(useSearchTabsStore.getState().tabs)).toHaveLength(2)
    })
  })

  describe('appendResults', () => {
    it('adds results to an empty tab', () => {
      const id = useSearchTabsStore.getState().addTab('test')
      const results = [makeResult({ seeders: 10 }), makeResult({ info_hash: 'def456', seeders: 5 })]

      useSearchTabsStore.getState().appendResults(id, results)
      const tab = useSearchTabsStore.getState().tabs[id]
      expect(tab.results).toHaveLength(2)
      // Sorted by seeders descending
      expect(tab.results![0].seeders).toBe(10)
      expect(tab.results![1].seeders).toBe(5)
    })

    it('deduplicates by info_hash, keeping highest seeders', () => {
      const id = useSearchTabsStore.getState().addTab('test')
      useSearchTabsStore.getState().appendResults(id, [
        makeResult({ info_hash: 'abc', seeders: 10 }),
      ])
      // Same info_hash but higher seeders
      useSearchTabsStore.getState().appendResults(id, [
        makeResult({ info_hash: 'abc', seeders: 50 }),
      ])
      const tab = useSearchTabsStore.getState().tabs[id]
      expect(tab.results).toHaveLength(1)
      expect(tab.results![0].seeders).toBe(50)
    })

    it('does NOT replace with lower seeders', () => {
      const id = useSearchTabsStore.getState().addTab('test')
      useSearchTabsStore.getState().appendResults(id, [
        makeResult({ info_hash: 'abc', seeders: 100 }),
      ])
      useSearchTabsStore.getState().appendResults(id, [
        makeResult({ info_hash: 'abc', seeders: 20 }),
      ])
      const tab = useSearchTabsStore.getState().tabs[id]
      expect(tab.results).toHaveLength(1)
      expect(tab.results![0].seeders).toBe(100)
    })

    it('deduplicates by link when info_hash is null', () => {
      const id = useSearchTabsStore.getState().addTab('test')
      useSearchTabsStore.getState().appendResults(id, [
        makeResult({ info_hash: null, link: 'magnet:x', seeders: 5 }),
      ])
      useSearchTabsStore.getState().appendResults(id, [
        makeResult({ info_hash: null, link: 'magnet:x', seeders: 20 }),
      ])
      const tab = useSearchTabsStore.getState().tabs[id]
      expect(tab.results).toHaveLength(1)
      expect(tab.results![0].seeders).toBe(20)
    })

    it('skips results with no info_hash and no link', () => {
      const id = useSearchTabsStore.getState().addTab('test')
      useSearchTabsStore.getState().appendResults(id, [
        makeResult({ info_hash: null, link: null }),
        makeResult({ seeders: 42 }),
      ])
      const tab = useSearchTabsStore.getState().tabs[id]
      // Only the one with info_hash should be included
      expect(tab.results).toHaveLength(1)
      expect(tab.results![0].seeders).toBe(42)
    })

    it('does nothing for nonexistent tab', () => {
      useSearchTabsStore.getState().appendResults('nonexistent', [makeResult()])
      const state = useSearchTabsStore.getState()
      expect(state.tabs['nonexistent']).toBeUndefined()
    })
  })

  describe('closeTab', () => {
    it('removes tab and activates last remaining tab', () => {
      const id1 = useSearchTabsStore.getState().addTab('q1')
      const id2 = useSearchTabsStore.getState().addTab('q2')
      const id3 = useSearchTabsStore.getState().addTab('q3')

      useSearchTabsStore.getState().closeTab(id3) // close active
      const state = useSearchTabsStore.getState()
      expect(state.tabs[id3]).toBeUndefined()
      expect(state.activeTabId).toBe(id2) // last remaining
    })

    it('sets activeTabId to null when closing last tab', () => {
      const id = useSearchTabsStore.getState().addTab('only')
      useSearchTabsStore.getState().closeTab(id)
      expect(useSearchTabsStore.getState().activeTabId).toBeNull()
      expect(useSearchTabsStore.getState().tabs).toEqual({})
    })

    it('keeps active tab when closing inactive tab', () => {
      const id1 = useSearchTabsStore.getState().addTab('q1')
      const id2 = useSearchTabsStore.getState().addTab('q2')
      useSearchTabsStore.getState().switchTab(id1)
      useSearchTabsStore.getState().closeTab(id2)
      expect(useSearchTabsStore.getState().activeTabId).toBe(id1)
    })
  })

  describe('markSearchDone', () => {
    it('sets loading to false and clears currentEngine', () => {
      const id = useSearchTabsStore.getState().addTab('test')
      useSearchTabsStore.getState().setCurrentEngine(id, 'piratebay')
      useSearchTabsStore.getState().markSearchDone(id)
      const tab = useSearchTabsStore.getState().tabs[id]
      expect(tab.loading).toBe(false)
      expect(tab.currentEngine).toBeNull()
    })
  })
})
