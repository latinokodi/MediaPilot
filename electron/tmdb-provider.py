#!/usr/bin/env python3
"""
tmdb-provider.py — TMDB API bridge for TorDownloader Electron.
No external deps, stdlib only.

Usage:
  python tmdb-provider.py lists                  → trending/popular/topRated
  python tmdb-provider.py detail <id> <type>     → movie or series detail
  python tmdb-provider.py season <id> <season>   → episode list
  python tmdb-provider.py search <query>         → multi search

All output is JSON to stdout. TMDB API key from TMDB_API_KEY env var.
"""

import sys
import json
import os
import urllib.request
import urllib.parse

TMDB_KEY = os.environ.get('TMDB_API_KEY', '')
TMDB_BASE = 'https://api.themoviedb.org/3'
TMDB_IMAGE = 'https://image.tmdb.org/t/p'

UA = 'TorDownloader-PRO/1.0'


class TMDBError(Exception):
    pass


def tmdb_get(path, params=None):
    """Call TMDB API and return parsed JSON. Raises TMDBError on failure."""
    if params is None:
        params = {}
    params['api_key'] = TMDB_KEY
    params['language'] = 'es-ES'
    qs = urllib.parse.urlencode(params)
    url = f'{TMDB_BASE}{path}?{qs}'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
            return json.loads(body)
    except Exception as e:
        raise TMDBError(str(e)) from e


def poster_url(path, size='w342'):
    if not path:
        return None
    return f'{TMDB_IMAGE}/{size}{path}'


def backdrop_url(path, size='w780'):
    if not path:
        return None
    return f'{TMDB_IMAGE}/{size}{path}'


def format_item(item, media_type):
    title = item.get('title') or item.get('name', '')
    return {
        'id': item['id'],
        'title': title,
        'overview': item.get('overview', ''),
        'poster': poster_url(item.get('poster_path')),
        'backdrop': backdrop_url(item.get('backdrop_path')),
        'year': (item.get('release_date') or item.get('first_air_date') or '')[:4],
        'rating': round(item.get('vote_average', 0), 1),
        'media_type': media_type,
    }


def cmd_lists():
    """Colecciones de Explorar: listas base + cartelera/emisión + un género por colección."""
    from concurrent.futures import ThreadPoolExecutor

    jobs: list[tuple[str, str, str, str, dict | None]] = [
        ('movies', 'trending', 'Tendencias', '/trending/movie/week', None),
        ('movies', 'popular', 'Populares', '/movie/popular', None),
        ('movies', 'top_rated', 'Mejor valoradas', '/movie/top_rated', None),
        ('movies', 'now_playing', 'En cartelera', '/movie/now_playing', None),
        ('movies', 'upcoming', 'Próximamente', '/movie/upcoming', None),
        ('tv', 'trending', 'Tendencias', '/trending/tv/week', None),
        ('tv', 'popular', 'Populares', '/tv/popular', None),
        ('tv', 'top_rated', 'Mejor valoradas', '/tv/top_rated', None),
        ('tv', 'airing_today', 'Hoy en emisión', '/tv/airing_today', None),
        ('tv', 'on_the_air', 'Al aire', '/tv/on_the_air', None),
    ]

    # Una colección por género (los nombres vienen localizados de TMDB).
    for media, list_path in (('movies', '/genre/movie/list'), ('tv', '/genre/tv/list')):
        try:
            genres = tmdb_get(list_path, {}).get('genres', [])
        except Exception:
            genres = []
        for genre in genres:
            gid = genre.get('id')
            name = genre.get('name')
            if not gid or not name:
                continue
            path = '/discover/movie' if media == 'movies' else '/discover/tv'
            jobs.append((media, f'genre_{gid}', name, path, {'with_genres': gid, 'sort_by': 'popularity.desc'}))

    result = {'movies': {}, 'tv': {}, 'collections': {'movies': [], 'tv': []}}

    def fetch(job):
        media, key, label, path, params = job
        try:
            data = tmdb_get(path, dict(params) if params else {})
            return media, key, label, data.get('results', [])[:20]
        except Exception:
            return media, key, label, []

    with ThreadPoolExecutor(max_workers=8) as pool:
        for media, key, label, items in pool.map(fetch, jobs):
            fmt_type = 'movie' if media == 'movies' else 'tv'
            result[media][key] = [format_item(item, fmt_type) for item in items]
            poster = None
            if items and items[0].get('poster_path'):
                poster = f"{TMDB_IMAGE}/w342{items[0]['poster_path']}"
            result['collections'][media].append({
                'key': key,
                'label': label,
                'count': len(items),
                'poster': poster,
            })

    return result


def cmd_detail(tmdb_id, media_type):
    if media_type == 'movie':
        data = tmdb_get(f'/movie/{tmdb_id}')
        ext = tmdb_get(f'/movie/{tmdb_id}/external_ids')
        result = format_item(data, 'movie')
        result['imdb_id'] = ext.get('imdb_id')
        result['runtime'] = data.get('runtime', 0)
        result['genres'] = [g['name'] for g in data.get('genres', [])]
        result['original_title'] = data.get('original_title', '')
        result['release_date'] = data.get('release_date', '')
        result['status'] = data.get('status', '')
    else:
        data = tmdb_get(f'/tv/{tmdb_id}')
        ext = tmdb_get(f'/tv/{tmdb_id}/external_ids')
        result = format_item(data, 'tv')
        result['imdb_id'] = ext.get('imdb_id')
        result['seasons'] = [
            {
                'season_number': s['season_number'],
                'name': s['name'],
                'episode_count': s['episode_count'],
                'air_date': s.get('air_date', ''),
                'poster': poster_url(s.get('poster_path')),
            }
            for s in data.get('seasons', [])
            if s.get('season_number', 0) > 0
        ]
        result['genres'] = [g['name'] for g in data.get('genres', [])]
        result['original_title'] = data.get('original_name', '')
        result['first_air_date'] = data.get('first_air_date', '')
        result['status'] = data.get('status', '')
        # Duración típica de la serie: permite validar un release aunque TMDB
        # todavía no tenga runtime para el episodio recién emitido.
        result['episode_run_time'] = [int(n) for n in (data.get('episode_run_time') or []) if isinstance(n, (int, float)) and n]
        next_ep = data.get('next_episode_to_air') or {}
        result['next_episode_to_air'] = {
            'season_number': next_ep.get('season_number'),
            'episode_number': next_ep.get('episode_number'),
            'air_date': next_ep.get('air_date', ''),
            'name': next_ep.get('name', ''),
        } if next_ep else None

    return result


def cmd_season(tmdb_id, season_number):
    data = tmdb_get(f'/tv/{tmdb_id}/season/{season_number}')
    episodes = []
    for ep in data.get('episodes', []):
        episodes.append({
            'episode_number': ep['episode_number'],
            'name': ep.get('name', ''),
            'overview': ep.get('overview', ''),
            'still': poster_url(ep.get('still_path'), 'w300'),
            'air_date': ep.get('air_date', ''),
            'runtime': ep.get('runtime'),
        })
    return {'season_number': season_number, 'episodes': episodes}


def cmd_search(query):
    params = {'query': query, 'page': 1}
    data = tmdb_get('/search/multi', params)
    results = []
    for item in data.get('results', []):
        media_type = item.get('media_type', '')
        if media_type not in ('movie', 'tv'):
            continue
        results.append(format_item(item, media_type))
    return results


def cmd_alt_titles(tmdb_id, media_type):
    kind = 'tv' if media_type in ('tv', 'series') else 'movie'
    data = tmdb_get(f'/{kind}/{tmdb_id}/alternative_titles', {})
    raw = data.get('titles') or data.get('results') or []
    titles, seen = [], set()
    for item in raw:
        title = (item.get('title') or '').strip()
        iso = (item.get('iso_3166_1') or '').upper()
        if title and title not in seen and (not iso or iso in ('ES', 'MX', 'US', 'AR', 'CO', 'CL', 'PE')):
            seen.add(title)
            titles.append(title)
    return titles


def main():
    if not TMDB_KEY:
        print(json.dumps({'error': 'TMDB_API_KEY not set'}))
        sys.exit(1)

    args = sys.argv[1:]
    if not args:
        print(json.dumps({'error': 'No command'}))
        sys.exit(1)

    cmd = args[0]
    try:
        if cmd == 'lists':
            result = cmd_lists()
        elif cmd == 'detail' and len(args) >= 3:
            result = cmd_detail(args[1], args[2])
        elif cmd == 'season' and len(args) >= 3:
            result = cmd_season(args[1], args[2])
        elif cmd == 'search' and len(args) >= 2:
            result = cmd_search(args[1])
        elif cmd == 'alt_titles' and len(args) >= 3:
            result = cmd_alt_titles(args[1], args[2])
        else:
            print(json.dumps({'error': f'Unknown command: {cmd}'}))
            sys.exit(1)

        print(json.dumps(result))

    except TMDBError as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
