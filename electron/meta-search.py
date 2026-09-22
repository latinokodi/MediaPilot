#!/usr/bin/env python3
"""
meta-search.py — Metasearch backend for TorDownloader PRO web mode.

Replaces the bundled qBittorrent .py engine plugins with:
  1. Jackett (Torznab API) — queries a curated subset of indexers in
     parallel (the /all/ aggregate hangs when 90+ indexers are enabled).
  2. Latino providers (Cinecalidad / Comet / TCL) — the text query is
     resolved to an IMDB id via TMDB, then the three latino providers
     run exactly as in the Discover tab.

Usage:
  python meta-search.py [--stream] "<query>"

Stream mode emits JSON lines (engine_start / engine_results / done) —
the same protocol as the old qbit-runner.py, so the server handler and
the UI progress display work unchanged.

Env:
  JACKETT_URL        default http://127.0.0.1:9117
  JACKETT_API_KEY    required for Jackett results
  JACKETT_INDEXERS   comma-separated subset (curated default below)
  TMDB_API_KEY       enables the query -> IMDB resolution (latino part)
"""

import sys
import os
import json
import re
import urllib.request
import urllib.parse
import concurrent.futures
import xml.etree.ElementTree as ET
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))

# ── Latino providers (Cinecalidad / Comet / TCL) — reused as-is ──
_spec = importlib.util.spec_from_file_location(
    'latino_providers', os.path.join(HERE, 'latino-providers.py'))
assert _spec is not None and _spec.loader is not None
lp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lp)

# ── Jackett config ────────────────────────────────────────────
JACKETT_URL = os.environ.get('JACKETT_URL', 'http://127.0.0.1:9117').rstrip('/')
JACKETT_API_KEY = os.environ.get('JACKETT_API_KEY', '')

DEFAULT_INDEXERS = [
    # general / EN
    '1337x', 'eztv', 'thepiratebay', 'yts', 'torrentgalaxyclone',
    'torrentdownloads', 'therarbg', 'subsplease',
    # latino / ES
    'dontorrent', 'divxtotal', 'wolfmax4k', 'catorrent', 'limetorrents',
    'extratorrent-st', 'torrentproject2', 'torrent9',
]
JACKETT_INDEXERS = [
    i.strip() for i in os.environ.get(
        'JACKETT_INDEXERS', ','.join(DEFAULT_INDEXERS)).split(',') if i.strip()
]

SEARCH_TIMEOUT = 12  # per-indexer request timeout
GLOBAL_CUTOFF = 20   # don't wait longer than this for stragglers


# ── HTTP ───────────────────────────────────────────────────────

def http_get(url, timeout=SEARCH_TIMEOUT):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TorDownloader-PRO/1.0',
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode('utf-8', errors='replace')
    except Exception:
        return ''


def extract_info_hash(link):
    if not link:
        return None
    m = re.search(r'btih:([a-fA-F0-9]{40})', link)
    if m:
        return m.group(1).lower()
    m = re.search(r'btih:([a-zA-Z2-7]{32})', link)
    if m:
        return m.group(1).lower()
    return None


# ── Jackett (Torznab) ──────────────────────────────────────────

def parse_torznab(xml_text, indexer):
    results = []
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return results
    ns = {'t': 'http://torznab.com/schemas/2015/feed'}
    for item in root.iter('item'):
        title = (item.findtext('title') or '').strip()
        link = (item.findtext('link') or '').strip()
        if not title or not link:
            continue
        size_raw = (item.findtext('size') or '0').strip()
        seeders = 0
        peers = 0
        for attr in item.findall('t:attr', ns):
            name = attr.get('name')
            val = attr.get('value')
            if name == 'seeders':
                try:
                    seeders = int(val or 0)
                except (TypeError, ValueError):
                    seeders = 0
            elif name == 'peers':
                try:
                    peers = int(val or 0)
                except (TypeError, ValueError):
                    peers = 0
        results.append({
            'title': title,
            'size': size_raw,
            'seeders': seeders,
            'peers': peers,
            'link': link,
            'indexer': indexer,
            'info_hash': extract_info_hash(link),
        })
    return results


def jackett_search(query):
    if not JACKETT_API_KEY:
        print('[meta-search] No JACKETT_API_KEY configured — skipping Jackett', file=sys.stderr)
        return []

    def query_indexer(idx):
        url = (
            f'{JACKETT_URL}/api/v2.0/indexers/{urllib.parse.quote(idx)}/results/torznab'
            f'?apikey={urllib.parse.quote(JACKETT_API_KEY)}'
            f'&t=search&q={urllib.parse.quote(query)}'
        )
        return parse_torznab(http_get(url), idx)

    results = []
    workers = min(len(JACKETT_INDEXERS), 8)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(query_indexer, idx): idx for idx in JACKETT_INDEXERS}
        try:
            for fut in concurrent.futures.as_completed(futures, timeout=GLOBAL_CUTOFF):
                try:
                    results.extend(fut.result())
                except Exception:
                    pass
        except concurrent.futures.TimeoutError:
            # Stragglers: collect what already finished, drop the rest
            for fut in futures:
                if fut.done():
                    try:
                        results.extend(fut.result())
                    except Exception:
                        pass
    return results


# ── Query -> IMDB resolution ───────────────────────────────────

def extract_episode(query):
    q = query.lower()
    m = re.search(r'\bs(\d{1,2})\s*e(\d{1,2})\b', q)
    if m:
        return m.group(1), m.group(2)
    m = re.search(r'\bseason\s+(\d{1,2})\b.{0,20}?(?:episode\s+)?(\d{1,2})\b', q)
    if m:
        return m.group(1), m.group(2)
    m = re.search(r'\b(\d{1,2})x(\d{1,2})\b', q)
    if m:
        return m.group(1), m.group(2)
    m = re.search(r'\bcap[íi]tulo\s*(\d{1,3})\b', q)
    if m:
        return '1', m.group(1)
    return None, None


def resolve_imdb(query):
    """TMDB multi-search -> best hit -> imdb_id + media type + S/E."""
    key = os.environ.get('TMDB_API_KEY', '')
    if not key:
        return None
    try:
        # Year hint: prefer a result whose date matches a year in the query
        year_m = re.search(r'\b(19|20)\d{2}\b', query)
        year_query = year_m.group(0) if year_m else None

        # Strip episode markers ("s01e01", "season 2", "1x05", "cap 305")
        # AND years so TMDB can match the title itself.
        clean_q = re.sub(
            r'\bs\d{1,2}\s*e\d{1,2}\b|\bseason\s+\d+\b|\b\d{1,2}x\d{1,2}\b'
            r'|\bcap[íi]tulo\s*\d{1,3}\b|\b(19|20)\d{2}\b',
            ' ', query, flags=re.I)
        clean_q = ' '.join(clean_q.split())
        if not clean_q:
            clean_q = query

        url = (
            'https://api.themoviedb.org/3/search/multi'
            f'?query={urllib.parse.quote(clean_q)}&api_key={key}&language=es&include_adult=false'
        )
        data = json.loads(http_get(url, timeout=12))
        results = [r for r in (data.get('results') or [])
                   if r.get('media_type') in ('movie', 'tv')]
        if not results:
            return None

        best = results[0]
        if year_query:
            for r in results:
                date = str(r.get('release_date') or r.get('first_air_date') or '')
                if date.startswith(year_query):
                    best = r
                    break

        media_type = best['media_type']
        ext = (
            f'https://api.themoviedb.org/3/{media_type}/{best["id"]}/external_ids'
            f'?api_key={key}'
        )
        ext_data = json.loads(http_get(ext, timeout=12))
        imdb_id = ext_data.get('imdb_id')
        if not imdb_id:
            return None
        season, episode = extract_episode(query)
        return {
            'imdb_id': imdb_id,
            'media_type': media_type,
            'season': season,
            'episode': episode,
        }
    except Exception:
        return None


# ── Latino providers ───────────────────────────────────────────

def latino_search(meta):
    if not meta:
        return []
    imdb_id = meta['imdb_id']
    mtype = meta['media_type']
    season = meta.get('season')
    episode = meta.get('episode')

    providers = {
        'TCL': lp.provider_tcl,
        'Cinecalidad': lp.provider_cinecalidad,
        'Comet': lp.provider_comet,
    }
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        futures = {
            ex.submit(fn, imdb_id, mtype, season, episode): name
            for name, fn in providers.items()
        }
        for fut in concurrent.futures.as_completed(futures, timeout=50):
            try:
                results.extend(fut.result())
            except Exception:
                pass
    return results


# ── Merge / dedupe ─────────────────────────────────────────────

def dedupe(results):
    seen = {}
    for r in results:
        key = r.get('info_hash') or r.get('link')
        if not key:
            continue
        if key not in seen or r['seeders'] > seen[key]['seeders']:
            seen[key] = r
    return sorted(seen.values(), key=lambda x: x['seeders'], reverse=True)


# ── Main ───────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    stream_mode = '--stream' in args
    jackett_only = '--jackett-only' in args
    clean = [a for a in args if not a.startswith('--')]
    if not clean or not clean[0].strip():
        print(json.dumps([]))
        sys.exit(0)
    query = clean[0].strip()

    if stream_mode:
        print(json.dumps({'type': 'engine_start', 'engine': 'Jackett'}), flush=True)

    # Jackett and the latino providers are independent — run in parallel
    # (--jackett-only skips the latino part, used by the Discover tab).
    def run_jackett():
        results = jackett_search(query)
        if stream_mode:
            print(json.dumps({
                'type': 'engine_results', 'engine': 'Jackett', 'results': results,
            }), flush=True)
        return results

    def run_latino():
        meta = resolve_imdb(query)
        results = latino_search(meta) if meta else []
        if stream_mode:
            print(json.dumps({
                'type': 'engine_results', 'engine': 'Latino', 'results': results,
            }), flush=True)
        return results

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        f_jackett = ex.submit(run_jackett)
        f_latino = ex.submit(run_latino) if not jackett_only else None
        jackett_results = f_jackett.result(timeout=GLOBAL_CUTOFF + 15)
        latino_results = f_latino.result(timeout=75) if f_latino else []

    final = dedupe(jackett_results + latino_results)

    if stream_mode:
        print(json.dumps({'type': 'done', 'total': len(final)}), flush=True)
    else:
        print(json.dumps(final, indent=2))


if __name__ == '__main__':
    main()
