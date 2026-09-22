// tmdb.ts — TMDB access for the automation engine. Spawns tmdb-provider.py
// (same code path the UI uses) so there is exactly one TMDB integration.
import { getSettings } from './db'
import { runPythonJson, setupSearchEnv } from './python-run'

export interface TmdbSeasonSummary {
  season_number: number
  name: string
  episode_count: number
  air_date: string
  poster: string | null
}

export interface TmdbEpisode {
  episode_number: number
  name: string
  overview: string
  still: string | null
  air_date: string
  runtime?: number | null
}

export interface TmdbDetail {
  id: number
  title: string
  overview: string
  poster: string | null
  backdrop: string | null
  year: string
  rating: number
  media_type: 'movie' | 'tv'
  imdb_id: string | null
  genres: string[]
  original_title: string
  status: string
  // movie
  release_date?: string
  runtime?: number
  // tv
  seasons?: TmdbSeasonSummary[]
  first_air_date?: string
  /** Duración típica de los episodios (min) — respaldo cuando falta el runtime del capítulo. */
  episode_run_time?: number[]
  next_episode_to_air?: { season_number: number; episode_number: number; air_date: string; name: string } | null
}

function withKey(): string {
  const key = getSettings().tmdb_api_key || ''
  if (!key) throw new Error('TMDB API key is not configured (Settings → TMDB)')
  return key
}

/** Fetch full detail for a movie or series (additive fields from cmd_detail). */
export async function tmdbDetail(tmdbId: number, mediaType: 'movie' | 'series'): Promise<TmdbDetail | null> {
  const kind = mediaType === 'movie' ? 'movie' : 'tv'
  const key = withKey()
  setupSearchEnv({ tmdb_api_key: key, jackett_url: '', jackett_api_key: '' })
  const data = await runPythonJson('tmdb-provider.py', ['detail', String(tmdbId), kind], { TMDB_API_KEY: key }, 30_000)
  return data && typeof data === 'object' ? (data as TmdbDetail) : null
}

/** Fetch one season's episode list (episodes carry air_date). */
export async function tmdbSeason(tmdbId: number, seasonNumber: number): Promise<{ season_number: number; episodes: TmdbEpisode[] } | null> {
  const key = withKey()
  const data = await runPythonJson('tmdb-provider.py', ['season', String(tmdbId), String(seasonNumber)], { TMDB_API_KEY: key }, 30_000)
  return data && typeof data === 'object' ? data : null
}

/**
 * Alternative titles for a title (ES/MX/US/AR/CO/CL/PE). Used by media-layout
 * to find the folder a show ALREADY lives in when the release name is in
 * another language (e.g. library folder from Sonarr's Spanish title vs the
 * English release name) — never create a second folder for one show.
 */
export async function tmdbAltTitles(tmdbId: number, mediaType: 'tv' | 'movie' | 'series'): Promise<string[]> {
  try {
    const key = withKey()
    const kind = mediaType === 'movie' ? 'movie' : 'series'
    const data = await runPythonJson('tmdb-provider.py', ['alt_titles', String(tmdbId), kind], { TMDB_API_KEY: key }, 30_000)
    return Array.isArray(data) ? data.filter((t) => typeof t === 'string' && t.trim()).map((t) => String(t).trim()) : []
  } catch { return [] }
}
