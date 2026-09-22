import { useEffect, useCallback, useState } from 'react'
import { useDiscoverStore, type TMDBItem, type TMDBLists, type EpisodeInfo } from '../store/discoverTabs'
import { DiscoverThumbnails } from './DiscoverThumbnails'
import { SeriesPicker } from './SeriesPicker'
import { DiscoverResults } from './DiscoverResults'
import { Compass, Search } from 'lucide-react'

interface Props {
  onDownloadAdded: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
  service: string
  hasTorbox: boolean
  hasRealdebrid: boolean
}

export function DiscoverView({ onDownloadAdded, showToast, service, hasTorbox, hasRealdebrid }: Props) {
  const store = useDiscoverStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<TMDBItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  // Catalog state
  const [catalogs, setCatalogs] = useState<any[] | null>(null)
  const [selectedCatalog, setSelectedCatalog] = useState<string | null>(null)
  const [catalogItems, setCatalogItems] = useState<any[] | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [sourceType, setSourceType] = useState<'tmdb' | 'catalog'>('tmdb')
  const [catalogVideos, setCatalogVideos] = useState<any[] | null>(null)
  const {
    lists,
    listsLoading,
    listsError,
    listType,
    mediaTab,
    detailItem,
    detailLoading,
    selectedSeason,
    hasKey,
    setLists,
    setListsError,
    setListType,
    setMediaTab,
    setDetailItem,
    setDetailLoading,
    setEpisodes,
    appendProviderResults,
    setCurrentProvider,
    setProviderLoading,
    clearProviderSearch,
    setHasKey,
  } = store

  // Colecciones disponibles para la pestaña activa (lista larga del backend;
  // fallback a las 3 clásicas si el backend aún no las manda).
  const FALLBACK_COLLECTIONS = [
    { key: 'trending', label: 'Tendencias' },
    { key: 'popular', label: 'Populares' },
    { key: 'top_rated', label: 'Mejor valoradas' },
  ]
  const collections: { key: string; label: string }[] =
    lists?.collections?.[mediaTab]?.length ? lists.collections[mediaTab]! : FALLBACK_COLLECTIONS

  // Si la colección seleccionada no existe en esta pestaña (p. ej. "Al aire"
  // solo aplica a series), saltar a la primera disponible.
  useEffect(() => {
    if (collections.length > 0 && !collections.some((c) => c.key === listType)) {
      setListType(collections[0].key)
    }
  }, [collections, listType, setListType])

  // Fetch episodes when a season is selected
  useEffect(() => {
    if (!selectedSeason || !detailItem) return

    // Catalog series: extract episodes from stored videos
    if (sourceType === 'catalog' && catalogVideos) {
      const eps = catalogVideos
        .filter((v: any) => v.season === selectedSeason.season_number)
        .map((v: any) => ({
          episode_number: v.episode,
          name: v.title || `Episodio ${v.episode}`,
          overview: v.overview || '',
          still: v.thumbnail || null,
          air_date: v.released || '',
        }))
        .sort((a: any, b: any) => a.episode_number - b.episode_number)
      setEpisodes(eps)
      return
    }

    // TMDB series: call API
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    electronAPI.tmdbSeason(detailItem.id, selectedSeason.season_number).then((res: any) => {
      if (res.success) {
        setEpisodes(res.data.episodes)
      }
    }).catch(() => {})
  }, [selectedSeason?.season_number, detailItem?.id, sourceType])

  // Load TMDB lists on mount
  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    // Check if TMDB key exists
    electronAPI.getSettings().then((s: any) => {
      if (s?.tmdb_api_key) {
        setHasKey(true)
        loadLists()
      }
    }).catch(() => {})

    // Listen for latino search progress
    const cleanup = electronAPI.onLatinoSearchProgress?.((progress: any) => {
      if (progress.type === 'provider_start') {
        setCurrentProvider(progress.provider)
        if (!useDiscoverStore.getState().providerLoading) {
          setProviderLoading(true)
        }
      } else if (progress.type === 'provider_results') {
        if (progress.results?.length > 0) {
          // Tag each result with its provider so the store can keep
          // latino providers (TCL/Cinecalidad/Comet) on top
          appendProviderResults(progress.results.map((r: any) => ({ ...r, provider: progress.provider })))
        }
      } else if (progress.type === 'done') {
        setProviderLoading(false)
        setCurrentProvider(null)
      }
    })

    // Load catalog manifest
    electronAPI.catalogManifest?.().then((res: any) => {
      if (res.success) setCatalogs(res.data)
    }).catch(() => {})

    return () => { cleanup?.() }
  }, [])

  const loadLists = async () => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return
    setLists({ movies: {}, tv: {} } as any)
    try {
      const res = await electronAPI.tmdbLists()
      if (res.success) {
        setLists(res.data)
      } else {
        setListsError(res.error)
      }
    } catch (e: any) {
      setListsError(e.message || 'Failed to load TMDB lists')
    }
  }

  const handleItemClick = async (item: TMDBItem) => {
    if (sourceType === 'catalog') {
      // Catalog item: IMDB ID is item.id (stored as string)
      const imdbId = String(item.id || '')
      if (!imdbId) return

      setDetailLoading(true)
      clearProviderSearch()

      if ((item as any).media_type === 'movie') {
        // Movie: start provider search directly
        setDetailItem({
          ...item,
          imdb_id: imdbId,
          seasons: undefined,
        } as any)
        startProviderSearch(imdbId, 'movie')
        setDetailLoading(false)
      } else {
        // Series: fetch meta to get seasons/episodes
        setDetailItem({
          ...item,
          imdb_id: imdbId,
          seasons: [],
        } as any)
        fetchCatalogMeta(imdbId, 'series')
      }
      return
    }

    // TMDB item
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    setDetailLoading(true)
    clearProviderSearch()

    try {
      const res = await electronAPI.tmdbDetail(item.id, item.media_type)
      if (res.success) {
        setDetailItem(res.data)

        // If movie, immediately start provider search
        if (item.media_type === 'movie' && res.data.imdb_id) {
          startProviderSearch(res.data.imdb_id, 'movie')
        }
      }
    } catch (e: any) {
      showToast(e.message || 'Error', 'error')
    } finally {
      setDetailLoading(false)
    }
  }

  const startProviderSearch = async (imdbId: string, mediaType: string, season?: string, episode?: string) => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    setProviderLoading(true)
    setCurrentProvider(null)
    try {
      await electronAPI.latinoSearch(imdbId, mediaType, season, episode)
    } catch (e: any) {
      showToast(e.message || 'Search failed', 'error')
      setProviderLoading(false)
    }
  }

  const handleEpisodeSelect = async (ep: EpisodeInfo) => {
    if (!detailItem?.imdb_id) return
    const season = useDiscoverStore.getState().selectedSeason
    if (!season) return
    startProviderSearch(detailItem.imdb_id, 'series', String(season.season_number), String(ep.episode_number))
  }

  const handleBack = () => {
    clearProviderSearch()
    setSourceType('tmdb')
    setSelectedCatalog(null)
    setCatalogItems(null)
    setCatalogVideos(null)
  }

  const fetchCatalogMeta = async (imdbId: string, type: string) => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    try {
      const res = await electronAPI.catalogMeta(type, imdbId)
      if (res.success && res.data) {
        const meta = res.data
        // Extract seasons from videos (filter season > 0)
        const seasonMap = new Map<number, { season_number: number; name: string; episode_count: number }>()
        const videos = meta.videos || []
        for (const v of videos) {
          const s = v.season
          if (!s || s === 0) continue
          if (!seasonMap.has(s)) {
            seasonMap.set(s, { season_number: s, name: `Temporada ${s}`, episode_count: 0 })
          }
          seasonMap.get(s)!.episode_count++
        }
        const seasons = [...seasonMap.values()].sort((a, b) => a.season_number - b.season_number).map(s => ({
          ...s,
          poster: null as string | null,
        }))

        setDetailItem({
          id: meta.id,
          title: meta.name,
          poster: meta.poster,
          overview: meta.description || '',
          year: (meta.releaseInfo || '').split('-')[0],
          rating: parseFloat(meta.imdbRating) || 0,
          media_type: 'tv',
          imdb_id: imdbId,
          genres: meta.genres || [],
          seasons,
          backdrop: null,
        } as any)
        setCatalogVideos(videos)
        setDetailLoading(false)
      }
    } catch (_) {}
  }

  const handleCatalogSelect = async (catalogId: string) => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    setSelectedCatalog(catalogId)
    setSourceType('catalog')
    setCatalogLoading(true)
    clearProviderSearch()

    try {
      const catalog = catalogs?.find((c: any) => c.id === catalogId)
      if (!catalog) return
      const res = await electronAPI.catalogItems(catalog.type, catalogId)
      if (res.success) {
        setCatalogItems(res.data || [])
      }
    } catch (_) {}
    finally {
      setCatalogLoading(false)
    }
  }

  const handleTMDSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    const q = searchQuery.trim()
    if (!q) return
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    setSearching(true)
    setSearchResults(null)
    try {
      const res = await electronAPI.tmdbSearch(q)
      if (res.success && res.data) {
        setSearchResults(res.data)
      }
    } catch (_) {} 
    finally {
      setSearching(false)
    }
  }

  // No TMDB key
  if (!hasKey) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-text-muted font-mono uppercase tracking-widest gap-4 min-h-[400px]">
        <Compass size={48} className="opacity-30" />
        <p className="text-sm">TMDB API Key requerido</p>
        <p className="text-xs opacity-50 max-w-md text-center normal-case tracking-normal">
          Configura tu API key de TMDB en Settings para habilitar el catálogo de descubrimiento.
        </p>
      </div>
    )
  }

  // Loading lists
  if (listsLoading) {
    return (
      <div className="h-full flex items-center justify-center min-h-[400px]">
        <div className="flex items-center gap-3 font-mono uppercase tracking-widest text-sm text-accent">
          <div className="w-4 h-4 border-2 border-bg-panel border-t-accent rounded-full animate-spin" />
          Cargando catálogo...
        </div>
      </div>
    )
  }

  // Error loading lists
  if (listsError) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-danger font-mono gap-4 min-h-[400px]">
        <span className="text-4xl">⚠️</span>
        <p className="uppercase tracking-widest text-sm">{listsError}</p>
        <button className="btn border border-border hover:border-accent" onClick={loadLists}>
          Reintentar
        </button>
      </div>
    )
  }

  // Detail view (movie or series)
  if (detailItem) {
    const items = detailItem
    return (
      <div className="space-y-4">
        {/* Back button */}
        <button
          className="text-text-muted hover:text-accent font-mono text-xs uppercase tracking-wider flex items-center gap-2"
          onClick={handleBack}
        >
          ← Volver al catálogo
        </button>

        {/* Detail header */}
        <div className="glass-panel p-4 flex flex-col sm:flex-row gap-4">
          {items.poster && (
            <img src={items.poster} alt={items.title} className="w-24 h-36 object-cover" />
          )}
          <div className="flex-1">
            <h3 className="text-xl font-bold text-text-heading">{items.title}</h3>
            <div className="flex gap-3 text-xs font-mono text-text-muted mt-2">
              {items.year && <span>{items.year}</span>}
              {items.runtime && <span>{items.runtime} min</span>}
              {items.genres && <span>{items.genres.slice(0, 3).join(', ')}</span>}
            </div>
            {items.overview && (
              <p className="text-text-muted text-sm mt-2 line-clamp-3">{items.overview}</p>
            )}
          </div>
        </div>

        {/* Series picker */}
        {items.media_type === 'tv' && (
          <SeriesPicker onSelect={handleEpisodeSelect} />
        )}

        {/* Results */}
        <DiscoverResults
          onDownloadAdded={onDownloadAdded}
          showToast={showToast}
          service={service}
          hasTorbox={hasTorbox}
          hasRealdebrid={hasRealdebrid}
        />
      </div>
    )
  }

  // Catalog view
  let currentItems: any[]
  if (sourceType === 'catalog') {
    currentItems = (catalogItems || []).map((item: any) => ({
      id: item.id,  // IMDB ID
      title: item.name,
      poster: item.poster || null,
      year: item.releaseInfo || item.year || '',
      rating: parseFloat(item.imdbRating) || 0,
      media_type: item.type,
    }))
  } else {
    currentItems = searchResults || (lists?.[mediaTab]?.[listType] || [])
  }

  return (
    <div className="space-y-6">
      {/* Search field + Catalog selector */}
      <form className="flex flex-col sm:flex-row gap-3" onSubmit={handleTMDSearch}>
        <div className="flex-1 min-w-0 relative">
          <input
            type="text"
            className="input-field w-full"
            placeholder={sourceType === 'catalog' ? `Buscar en ${selectedCatalog}...` : 'Buscar en TMDB...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={sourceType === 'catalog'}
          />
        </div>
        {sourceType === 'tmdb' && (
          <>
            <button type="submit" className="btn btn-accent" disabled={searching}>
              <Search size={14} className="mr-1 inline" />
              {searching ? 'Buscando...' : 'Buscar'}
            </button>
            {searchResults && (
              <button
                type="button"
                className="btn border border-border hover:border-accent text-xs"
                onClick={() => { setSearchResults(null); setSearchQuery('') }}
              >
                Limpiar
              </button>
            )}
          </>
        )}
      </form>

      {/* Catalog selector */}
      {catalogs && catalogs.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs font-mono text-text-muted uppercase">Catálogos:</span>
          <select
            className="btn border border-border text-xs px-3 py-1.5 bg-bg-deep font-mono text-text-main w-full sm:w-auto sm:max-w-xs"
            value={selectedCatalog || ''}
            onChange={(e) => {
              const val = e.target.value
              if (val) handleCatalogSelect(val)
              else {
                setSelectedCatalog(null)
                setSourceType('tmdb')
                setCatalogItems(null)
              }
            }}
          >
            <option value="">TMDB</option>
            {catalogs.map((c: any) => (
              <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
            ))}
          </select>
          {catalogLoading && (
            <div className="w-4 h-4 border-2 border-bg-panel border-t-accent rounded-full animate-spin" />
          )}
        </div>
      )}

      {/* Tabs: movies / tv — only show when TMDB and not searching */}
      {sourceType === 'tmdb' && !searchResults && (
      <div className="flex gap-2">
        {(['movies', 'tv'] as const).map((tab) => (
          <button
            key={tab}
            className={`btn text-xs px-4 py-2 font-mono uppercase tracking-wider ${
              mediaTab === tab ? 'btn-accent' : 'border border-border hover:border-accent'
            }`}
            onClick={() => setMediaTab(tab)}
          >
            {tab === 'movies' ? 'Películas' : 'Series'}
          </button>
        ))}

        <div className="flex-1" />

        <div className="text-[10px] sm:text-[11px] text-text-muted">{collections.length} colecciones</div>
      </div>
      )}

      {/* Selector de colecciones (lista larga, desplazable) */}
      {(collections.length > 0) && (
        <div className="flex gap-2 overflow-x-auto pt-2 pb-2 -mx-1 px-1 scrollbar-none">
          {collections.map((c) => (
            <button
              key={c.key}
              className={`btn text-xs px-3 py-1.5 font-mono uppercase whitespace-nowrap shrink-0 ${
                listType === c.key ? 'bg-accent text-white border border-accent' : 'border border-border hover:border-accent text-text-muted'
              }`}
              onClick={() => setListType(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* Thumbnail grid */}
      {currentItems.length > 0 ? (
        <DiscoverThumbnails items={currentItems} onClick={handleItemClick} />
      ) : (
        <div className="flex items-center justify-center text-text-muted text-sm py-12">
          Sin resultados
        </div>
      )}
    </div>
  )
}
