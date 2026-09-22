import { create } from 'zustand'

export interface SearchResult {
  title: string | null
  size: string | null
  seeders: number
  peers: number
  link: string | null
  indexer: string
  info_hash: string | null
  engine?: string
}

export interface SearchTab {
  query: string
  results: SearchResult[] | null
  loading: boolean
  error: string | null
  currentEngine: string | null
}

interface SearchTabsState {
  tabs: Record<string, SearchTab>
  activeTabId: string | null
  counter: number
  addTab: (query: string) => string
  setTabResult: (id: string, results: SearchResult[]) => void
  setTabError: (id: string, error: string) => void
  appendResults: (id: string, results: SearchResult[]) => void
  setCurrentEngine: (id: string, engine: string | null) => void
  markSearchDone: (id: string) => void
  switchTab: (id: string) => void
  closeTab: (id: string) => void
}

export const useSearchTabsStore = create<SearchTabsState>((set, get) => ({
  tabs: {},
  activeTabId: null,
  counter: 0,

  addTab: (query) => {
    const id = String(get().counter + 1)
    set((s) => ({
      counter: s.counter + 1,
      activeTabId: id,
      tabs: {
        ...s.tabs,
        [id]: { query, results: null, loading: true, error: null, currentEngine: null },
      },
    }))
    return id
  },

  setTabResult: (id, results) =>
    set((s) => ({
      tabs: { ...s.tabs, [id]: { ...s.tabs[id], results, loading: false } },
    })),

  setTabError: (id, error) =>
    set((s) => ({
      tabs: { ...s.tabs, [id]: { ...s.tabs[id], error, loading: false } },
    })),

  appendResults: (id, newResults) =>
    set((s) => {
      const tab = s.tabs[id]
      if (!tab) return s
      const existing = tab.results ?? []
      // Deduplicate by info_hash, keeping highest seeders
      const seen = new Map<string, SearchResult>()
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
      // Latino engine first, then by seeders within each group
      const merged = [...seen.values()].sort((a, b) => {
        const aLat = a.engine === 'Latino' ? 0 : 1
        const bLat = b.engine === 'Latino' ? 0 : 1
        if (aLat !== bLat) return aLat - bLat
        return b.seeders - a.seeders
      })
      return {
        tabs: { ...s.tabs, [id]: { ...tab, results: merged } },
      }
    }),

  setCurrentEngine: (id, engine) =>
    set((s) => {
      const tab = s.tabs[id]
      if (!tab) return s
      return {
        tabs: { ...s.tabs, [id]: { ...tab, currentEngine: engine } },
      }
    }),

  markSearchDone: (id) =>
    set((s) => {
      const tab = s.tabs[id]
      if (!tab) return s
      return {
        tabs: { ...s.tabs, [id]: { ...tab, loading: false, currentEngine: null } },
      }
    }),

  switchTab: (id) => set({ activeTabId: id }),

  closeTab: (id) =>
    set((s) => {
      const { [id]: _, ...remaining } = s.tabs
      const ids = Object.keys(remaining)
      const newActive =
        s.activeTabId === id ? (ids.length > 0 ? ids[ids.length - 1] : null) : s.activeTabId
      return { tabs: remaining, activeTabId: newActive }
    }),
}))
