import { useDiscoverStore, type SeasonInfo, type EpisodeInfo } from '../store/discoverTabs'

interface Props {
  onSelect: (episode: EpisodeInfo) => void
}

export function SeriesPicker({ onSelect }: Props) {
  const {
    detailItem,
    selectedSeason,
    episodes,
    episodesLoading,
    selectedEpisode,
    setSelectedSeason,
    setSelectedEpisode,
  } = useDiscoverStore()

  if (!detailItem?.seasons) return null

  const handleSeasonClick = (season: SeasonInfo) => {
    setSelectedSeason(season)
    setSelectedEpisode(null)
  }

  const handleEpisodeClick = (ep: EpisodeInfo) => {
    setSelectedEpisode(ep)
    onSelect(ep)
  }

  return (
    <div className="space-y-4">
      {/* Seasons */}
      <div>
        <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">
          Temporadas
        </h4>
        <div className="flex gap-2 flex-wrap">
          {detailItem.seasons.map((s) => (
            <button
              key={s.season_number}
              className={`btn text-xs px-3 py-1.5 font-mono ${
                selectedSeason?.season_number === s.season_number
                  ? 'btn-accent'
                  : 'border border-border hover:border-accent'
              }`}
              onClick={() => handleSeasonClick(s)}
            >
              S{s.season_number}
            </button>
          ))}
        </div>
      </div>

      {/* Episodes */}
      {selectedSeason && (
        <div>
          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">
            {selectedSeason.name || `Temporada ${selectedSeason.season_number}`}
          </h4>
          {episodesLoading ? (
            <div className="flex items-center gap-3 text-text-muted text-sm p-4">
              <div className="w-4 h-4 border-2 border-bg-panel border-t-accent rounded-full animate-spin" />
              Cargando episodios...
            </div>
          ) : episodes && episodes.length > 0 ? (
            <div className="grid gap-2 max-h-64 overflow-y-auto">
              {episodes.map((ep) => (
                <button
                  key={ep.episode_number}
                  className={`glass-panel p-3 text-left transition-colors ${
                    selectedEpisode?.episode_number === ep.episode_number
                      ? 'border-accent bg-accent/10'
                      : 'hover:border-accent'
                  }`}
                  onClick={() => handleEpisodeClick(ep)}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="font-mono text-accent text-xs mr-2">
                        E{ep.episode_number}
                      </span>
                      <span className="text-text-heading text-sm">{ep.name}</span>
                    </div>
                    {ep.air_date && (
                      <span className="text-text-muted text-xs font-mono">{ep.air_date}</span>
                    )}
                  </div>
                  {ep.overview && (
                    <p className="text-text-muted text-xs mt-1 line-clamp-2">
                      {ep.overview}
                    </p>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-text-muted text-sm p-4">Sin episodios</p>
          )}
        </div>
      )}
    </div>
  )
}
