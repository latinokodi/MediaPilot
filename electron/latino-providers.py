#!/usr/bin/env python3
"""
latino-providers.py — IMDB-based torrent providers for TorDownloader Electron.
Ported from nuvio-latino Stremio addon.

Usage:
  python latino-providers.py <imdb_id> <type> [season] [episode]
  python latino-providers.py --stream <imdb_id> <type> [season] [episode]

  type: movie | series
  season/episode: required for series

Three providers:
  1. TCL — hacktorrent.to WordPress REST API
  2. Cinecalidad — via Torrentio proxy
  3. Comet — via Comet Stremio addon

Output: JSON lines (stream mode) or single JSON array (batch mode).
"""

import sys
import json
import re
import os
import base64
import urllib.request
import urllib.parse
import concurrent.futures
from typing import Optional

# ── Constants ───────────────────────────────────────────

TCL_HOST = 'https://hacktorrent.to'
TCL_API = f'{TCL_HOST}/wp-json/wpreact/v1'

CINECALIDAD_URL = 'https://torrentio.strem.fun/providers=cinecalidad'

COMET_BASE = (
    'https://comet.stremio.ru/'
    'eyJtYXhSZXN1bHRzUGVyUmVzb2x1dGlvbiI6MCwibWF4U2l6ZSI6MzIyMTIyNTQ3MjAs'
    'ImNhY2hlZE9ubHkiOmZhbHNlLCJzb3J0Q2FjaGVkVW5jYWNoZWRUb2dldGhlciI6ZmFs'
    'c2UsInJlbW92ZVRyYXNoIjp0cnVlLCJyZXN1bHRGb3JtYXQiOlsiYWxsIl0sImRlYnJp'
    'ZFNlcnZpY2VzIjpbXSwiZW5hYmxlVG9ycmVudCI6dHJ1ZSwiZGVkdXBsaWNhdGVTdHJl'
    'YW1zIjpmYWxzZSwic2NyYXBlRGVicmlkQWNjb3VudFRvcnJlbnRzIjpmYWxzZSwiZGVi'
    'cmlkU3RyZWFtUHJveHlQYXNzd29yZCI6IiIsImxhbmd1YWdlcyI6eyJyZXF1aXJlZCI6'
    'WyJsYSJdLCJhbGxvd2VkIjpbXSwiZXhjbHVkZSI6W10sInByZWZlcnJlZCI6WyJsYSJd'
    'fSwicmVzb2x1dGlvbnMiOnsicjQ4MHAiOmZhbHNlLCJyMzYwcCI6ZmFsc2UsInIyNDBw'
    'IjpmYWxzZX0sIm9wdGlvbnMiOnsicmVtb3ZlX3JhbmtzX3VuZGVyIjotMTAwMDAwMDAw'
    'MDAsImFsbG93X2VuZ2xpc2hfaW5fbGFuZ3VhZ2VzIjp0cnVlLCJyZW1vdmVfdW5rbm93'
    'bl9sYW5ndWFnZXMiOmZhbHNlfX0='
)

IMDB_SUGGESTION = 'https://v3.sg.media-imdb.com/suggestion'
CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta'
TRAKT_URL = 'https://api.trakt.tv'

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'udp://tracker.leechers-paradise.org:6969/announce',
]

HTML_TAG_RE = re.compile(r'<[^>]+>')
MAGNET_RE = re.compile(r'magnet:\?[^\s"\'<>]+', re.IGNORECASE)
INFO_HASH_RE = re.compile(r'btih:([a-fA-F0-9]{40})', re.IGNORECASE)


# ── HTTP helpers ────────────────────────────────────────

def http_get(url, timeout=15, referer=None, accept_json=False):
    """Simple HTTP GET, returns body string."""
    headers = {'User-Agent': UA}
    if referer:
        headers['Referer'] = referer
    if accept_json:
        headers['Accept'] = 'application/json'
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def http_get_json(url, timeout=15, referer=None):
    """HTTP GET returning parsed JSON."""
    return json.loads(http_get(url, timeout, referer, accept_json=True))


# ── Title normalization (matches nuvio-latino) ──────────

def normalize_title(text):
    if not text:
        return ''
    # Remove accents
    import unicodedata
    nfkd = unicodedata.normalize('NFKD', text)
    no_accents = ''.join(c for c in nfkd if not unicodedata.combining(c))
    lower = no_accents.lower()
    # Remove years
    lower = re.sub(r'\(\d{4}\)|\b\d{4}\b', ' ', lower)
    # Keep only alphanumeric
    lower = re.sub(r'[^a-z0-9]+', ' ', lower)
    return ' '.join(lower.split())


def build_magnet(info_hash, name=''):
    """Build a magnet URI from info_hash."""
    if not info_hash:
        return ''
    dn = f'&dn={urllib.parse.quote(name)}' if name else ''
    tr = ''.join(f'&tr={urllib.parse.quote(t)}' for t in TRACKERS)
    return f'magnet:?xt=urn:btih:{info_hash}{dn}{tr}'


def extract_info_hash(magnet_or_url):
    """Extract info_hash from a magnet link."""
    if not magnet_or_url:
        return None
    m = INFO_HASH_RE.search(magnet_or_url)
    return m.group(1).lower() if m else None


def format_result(title, magnet, info_hash, size='', source=''):
    """Format a result dict matching TorDownloader's MetaResult."""
    return {
        'title': title,
        'size': size or '0 B',
        'seeders': -1,
        'peers': -1,
        'link': magnet,
        'indexer': source,
        'info_hash': info_hash,
    }


# ── IMDB / Cinemeta / Trakt metadata resolution ─────────

def resolve_metadata(imdb_id, media_type):
    """
    Resolve title + year + TMDB id from IMDB → Cinemeta → Trakt → TMDB.

    Returns {'titles': [...], 'year': int|None, 'tmdb_id': str|None}.
    When a TMDB API key is available (env TMDB_API_KEY), Spanish titles
    are added via TMDB's find-by-imdb with language=es — the hacktorrent
    search matches Spanish titles, so this is what makes the TCL provider
    find content like "Avatar: El camino del agua".
    """
    titles = set()
    year = None
    primary_title = None
    tmdb_id = None

    # Step 1: IMDB Suggestion API (mandatory 'x/' path segment)
    try:
        data = http_get_json(
            f'{IMDB_SUGGESTION}/x/{imdb_id}.json',
            timeout=6,
        )
        items = data.get('d', [])
        for item in items:
            if item.get('id') and '/' in item['id']:
                continue
            if item.get('l'):
                primary_title = item['l']
                titles.add(item['l'])
            if item.get('y'):
                year = item['y']
            if primary_title:
                break
    except Exception:
        pass

    # Step 2: Cinemeta — TMDB id + title fallback
    try:
        cm_type = 'series' if media_type == 'series' else 'movie'
        data = http_get_json(f'{CINEMETA_URL}/{cm_type}/{imdb_id}.json', timeout=6)
        meta = data.get('meta', {})
        if meta.get('moviedb_id'):
            tmdb_id = str(meta['moviedb_id'])
        if not primary_title and meta.get('name'):
            primary_title = meta['name']
            titles.add(meta['name'])
            if meta.get('year'):
                y = str(meta['year'])
                m = re.search(r'\d{4}', y)
                if m:
                    year = int(m.group())
    except Exception:
        pass

    # Step 3: TMDB (when a key is available) — Spanish titles + authoritative TMDB id.
    # 'es' gives Spain titles, 'es-MX' gives LatAm titles — the hacktorrent site
    # uses LatAm titles ("Avatar: El camino del agua"), so both are queried.
    tmdb_key = os.environ.get('TMDB_API_KEY', '')
    if tmdb_key:
        for lang in ('es', 'es-MX'):
            try:
                data = http_get_json(
                    f'https://api.themoviedb.org/3/find/{imdb_id}'
                    f'?external_source=imdb_id&language={lang}&api_key={tmdb_key}',
                    timeout=6,
                )
                results = data.get('movie_results') or data.get('tv_results') or []
                if not results:
                    continue
                item = results[0]
                for f in ('title', 'original_title', 'name', 'original_name'):
                    v = item.get(f)
                    if v:
                        titles.add(v)
                if item.get('id'):
                    tmdb_id = str(item['id'])
                date = item.get('release_date') or item.get('first_air_date') or ''
                m = re.search(r'\d{4}', date)
                if m:
                    year = int(m.group())
            except Exception:
                pass

    # Step 4: Trakt aliases (best effort — may 403 without an API key)
    if not primary_title:
        try:
            trakt_type = 'shows' if media_type == 'series' else 'movies'
            data = http_get_json(
                f'{TRAKT_URL}/{trakt_type}/{imdb_id}/aliases',
                timeout=5,
            )
            for alias in data:
                if alias.get('title'):
                    titles.add(alias['title'])
        except Exception:
            pass

    if not primary_title and not titles:
        return None

    return {
        'titles': list(titles),
        'year': year,
        'tmdb_id': tmdb_id,
    }


# ── Provider: TCL (hacktorrent.to) ─────────────────────

def tcl_search_api(query, content_type):
    """Search hacktorrent.to WP REST API."""
    params = urllib.parse.urlencode({
        'query': query,
        'type': content_type,
        'page': '1',
    })
    try:
        data = http_get_json(
            f'{TCL_API}/search?{params}',
            timeout=10,
            referer=f'{TCL_HOST}/',
        )
        return data.get('results', [])
    except Exception:
        return []


def tcl_movie_detail(slug):
    """Get movie detail with downloads."""
    try:
        return http_get_json(
            f'{TCL_API}/movie/{urllib.parse.quote(slug)}',
            timeout=10,
            referer=f'{TCL_HOST}/',
        )
    except Exception:
        return None


def tcl_series_detail(slug, content_type):
    """Get series detail with downloads."""
    endpoint = 'anime' if content_type == 'anime' else 'serie'
    try:
        data = http_get_json(
            f'{TCL_API}/{endpoint}/{urllib.parse.quote(slug)}',
            timeout=10,
            referer=f'{TCL_HOST}/',
        )
        # Also fetch related downloads for series
        if endpoint == 'serie':
            try:
                related = http_get_json(
                    f'{TCL_API}/serie/{urllib.parse.quote(slug)}/related?vb=12',
                    timeout=8,
                    referer=f'{TCL_HOST}/',
                )
                if related and related.get('downloads'):
                    if data is None:
                        data = {}
                    data['downloads'] = related['downloads']
            except Exception:
                pass
        return data
    except Exception:
        return None


def _rot13(s):
    """ROT13 — acortalink encodes the site URL with it (linkser)."""
    out = []
    for ch in s:
        if 'a' <= ch <= 'z':
            out.append(chr((ord(ch) - ord('a') + 13) % 26 + ord('a')))
        elif 'A' <= ch <= 'Z':
            out.append(chr((ord(ch) - ord('A') + 13) % 26 + ord('A')))
        else:
            out.append(ch)
    return ''.join(out)


# Cached verdict for the Salted__ scheme: once we know the site's redirect
# chain resolves (or not), don't repeat the 4-request dance for every download.
_salted_resolvable = None  # None=unknown, True/False


def _acortalink_rphp_fetch(l_param, timeout=12):
    """Fetch r.php?l=<param>; return (magnet_or_None, redirect_target_or_None)."""
    try:
        resolve_url = f'https://acortalink.net/r.php?l={urllib.parse.quote(l_param, safe="")}'
        html = http_get(resolve_url, timeout=timeout, referer=f'{TCL_HOST}/')
        matches = MAGNET_RE.findall(html)
        if matches:
            return matches[0], None
        # Current site serves a JS redirect page instead of the magnet:
        # window.location = "<target>"  (also mirrored in the AQUI <a href>)
        m = (re.search(r'window\.location\s*=\s*"([^"\s]+)"', html)
             or re.search(r'<a\s+href="([^"\s]+)"', html))
        if m:
            return None, m.group(1)
        return None, None
    except Exception:
        return None, None


def _acortalink_salted_flow(blob, timeout=12):
    """
    Replicate the current acortalink resolution flow for OpenSSL "Salted__"
    encrypted links:

      s.php?i=<blob>  ->  POST / (linkser, session)  ->  POST /check.php "c"
      ->  r.php?l=<blob>  ->  follow the JS redirect target  ->  magnet

    Returns the magnet string or None. Uses a cookie jar so the session
    state (PHPSESSID / PHPINFO / countdown cookie) carries through.
    """
    global _salted_resolvable
    if _salted_resolvable is False:
        return None

    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [
        ('User-Agent', UA),
        ('Referer', f'{TCL_HOST}/'),
    ]

    def get(url, referer=None):
        headers = dict(opener.addheaders)
        if referer:
            headers['Referer'] = referer
        req = urllib.request.Request(url, headers=headers)
        try:
            with opener.open(req, timeout=timeout) as resp:
                return resp.read().decode('utf-8', errors='replace')
        except Exception:
            return ''

    def post(url, data, referer=None):
        headers = {'Content-Type': 'application/x-www-form-urlencoded'}
        if referer:
            headers['Referer'] = referer
        req = urllib.request.Request(url, data=data.encode(), headers=headers)
        try:
            with opener.open(req, timeout=timeout) as resp:
                return resp.read().decode('utf-8', errors='replace')
        except Exception:
            return ''

    qblob = urllib.parse.quote(blob, safe='')
    linkser = _rot13('https://hacktorrent.cc')

    # 1. s.php seeds the session (PHPSESSID + PHPINFO cookies)
    get(f'https://acortalink.net/s.php?i={qblob}', referer=f'{TCL_HOST}/')

    # 2. The protector page (mirrors the auto-submit form)
    post('https://acortalink.net/', f'linkser={linkser}',
         referer=f'https://acortalink.net/s.php?i={qblob}')

    # 3. Mark the countdown as done (the page JS POSTs "c" to /check.php)
    post('https://acortalink.net/check.php', 'c', referer='https://acortalink.net/')

    # 4. r.php -> JS redirect target
    magnet, target = _acortalink_rphp_fetch(blob, timeout)
    if magnet:
        _salted_resolvable = True
        return magnet

    if not target:
        _salted_resolvable = False
        print(f'[acortalink] Salted link: r.php gave no magnet/redirect for {blob[:24]}...', file=sys.stderr)
        return None

    # 5. Follow the redirect target (a path like /<blob>) with the session
    if target.startswith('http'):
        target_url = target
    else:
        target_url = 'https://acortalink.net/' + target.lstrip('/')
    try:
        html = get(target_url, referer='https://acortalink.net/r.php')
        matches = MAGNET_RE.findall(html)
        if matches:
            _salted_resolvable = True
            return matches[0]
    except Exception:
        pass

    _salted_resolvable = False
    print(f'[acortalink] Salted link unresolved: {target_url[:70]} '
          f'(OpenSSL-encrypted; site did not serve a magnet)', file=sys.stderr)
    return None


def resolve_acortalink(acorta_url):
    """
    Resolve an acortalink.net short URL to a magnet link.

    Two schemes:
      1. PLAIN (legacy) — the 'i' param base64-decodes to a plain URL.
         r.php?l=<url> historically returned HTML containing the magnet.
      2. SALTED (current) — the 'i' param base64-decodes to an OpenSSL
         "Salted__" AES blob. Resolution requires the session flow
         implemented in _acortalink_salted_flow().
    """
    try:
        parsed = urllib.parse.urlparse(acorta_url)
        qs = urllib.parse.parse_qs(parsed.query)
        i_param = qs.get('i', [''])[0]
        if not i_param:
            return None

        try:
            decoded = base64.b64decode(i_param).decode('utf-8', errors='replace')
        except Exception:
            return None

        # Scheme 1: plain URL
        if decoded.startswith('http'):
            magnet, _ = _acortalink_rphp_fetch(decoded)
            return magnet

        # Scheme 2: OpenSSL-encrypted blob ("U2FsdGVkX1" = base64 of "Salted__")
        if decoded.startswith('U2FsdGVkX1'):
            return _acortalink_salted_flow(decoded)

        return None
    except Exception:
        return None


def provider_tcl(imdb_id, media_type, season=None, episode=None):
    """Scrape hacktorrent.to for torrents matching IMDB ID."""
    results = []

    # Resolve metadata
    meta = resolve_metadata(imdb_id, media_type)
    if not meta:
        return results

    titles = meta['titles']
    year = meta['year']
    tmdb_id = meta.get('tmdb_id')

    # Content type mapping (TCL uses Spanish types)
    if media_type == 'movie':
        content_types = ['pelicula']
    else:
        content_types = ['serie', 'anime']

    # Try each title until we find a match. The site's search matches
    # Spanish titles best, so the resolved titles set now includes TMDB
    # Spanish titles (when a TMDB key is configured). Match priority:
    #   1. TMDB id equality (bulletproof when both sides have it)
    #   2. original_title (English) exact match
    #   3. localized title exact match
    #   4. year + meaningful token overlap (loose fallback)
    match = None
    active_ct = None
    normalized_titles = {normalize_title(t) for t in titles}
    for ct in content_types:
        for title in titles:
            api_results = tcl_search_api(title, ct)
            for item in api_results:
                item_title = HTML_TAG_RE.sub('', str(item.get('title', '') or '')).strip()
                item_orig = HTML_TAG_RE.sub('', str(item.get('original_title', '') or '')).strip()
                item_tmdb = str(item.get('tmdb_id', '') or '')
                item_year = str(item.get('year', '') or '')

                # 1. TMDB id match
                if tmdb_id and item_tmdb and item_tmdb == tmdb_id:
                    match = item
                    active_ct = ct
                    break

                # 2. original_title exact match (English titles)
                if item_orig and normalize_title(item_orig) in normalized_titles:
                    match = item
                    active_ct = ct
                    break

                # 3. localized title exact match
                if item_title and normalize_title(item_title) in normalized_titles:
                    match = item
                    active_ct = ct
                    break

                # 4. year + token overlap fallback
                if year and item_year and item_year == str(year):
                    norm_item = normalize_title(item_title)
                    norm_orig = normalize_title(item_orig)
                    toks = {w for w in (norm_item + ' ' + norm_orig).split() if len(w) > 3}
                    known = {w for w in ' '.join(normalized_titles).split() if len(w) > 3}
                    if toks and (toks & known):
                        match = item
                        active_ct = ct
                        break
            if match:
                break
        if match:
            break

    if not match:
        return results

    slug = match.get('slug', '')
    if not slug:
        return results

    # Get detail page with downloads
    downloads = []
    if media_type == 'movie':
        detail = tcl_movie_detail(slug)
        if detail:
            downloads = detail.get('downloads', [])
    else:
        detail = tcl_series_detail(slug, active_ct)
        if detail:
            all_downloads = detail.get('downloads', [])
            downloads = [
                d for d in all_downloads
                if str(d.get('season', '')) == str(season)
                and str(d.get('episode', '')) == str(episode)
            ]

    for dl in downloads:
        magnet = dl.get('download_link') or dl.get('magnet', '')
        if 'acortalink.net' in magnet:
            resolved = resolve_acortalink(magnet)
            if resolved:
                magnet = resolved

        info_hash = extract_info_hash(magnet)
        if not info_hash:
            continue

        title = dl.get('title') or match.get('title', '')
        quality = dl.get('quality', '')
        lang = dl.get('language', '')
        size = dl.get('size', '')

        label = title
        if quality:
            label += f' [{quality}]'

        results.append(format_result(
            label, magnet, info_hash, size, 'TCL',
        ))

    return results


# ── Provider: Cinecalidad (via Torrentio) ───────────────

def provider_cinecalidad(imdb_id, media_type, season=None, episode=None):
    """Scrape Cinecalidad torrents via Torrentio."""
    results = []

    if media_type == 'movie':
        path = f'stream/movie/{imdb_id}.json'
    else:
        if not season or not episode:
            return []
        path = f'stream/series/{imdb_id}:{season}:{episode}.json'

    url = f'{CINECALIDAD_URL}/{path}'
    try:
        data = http_get_json(url, timeout=20)
        streams = data.get('streams', [])
    except Exception:
        return results

    for s in streams:
        info_hash = (s.get('infoHash') or '').lower()
        if not info_hash:
            continue

        title = s.get('title', '')
        # Filter: only Cinecalidad provider
        provider_match = re.search(r'⚙[^\n]*?\s([^\s\n]+)', title)
        if provider_match and provider_match.group(1).lower() != 'cinecalidad':
            continue

        filename = (s.get('behaviorHints', {}).get('filename')
                    or title.split('\n')[0]
                    or info_hash)

        # Extract size from title
        size = ''
        size_match = re.search(r'💾\s*([\d.]+\s*[KMGT]B)', title, re.IGNORECASE)
        if size_match:
            size = size_match.group(1)

        magnet = build_magnet(info_hash, filename)
        results.append(format_result(filename, magnet, info_hash, size, 'CC'))

    return results


# ── Provider: Cinecalidad (web) — ¿ya está publicado en latino? ────────
#
# El índice del addon (provider_cinecalidad) sólo lista TORRENTS, y Cinecalidad
# publica cada episodio primero como DESCARGA DIRECTA (megaup/mediafire/...):
# comprobado con Demo2 S01E05 — la página del episodio existía con link
# megaup y 0 magnets, mientras el índice devolvía 0 streams. Sin esta
# comprobación la fase latino reportaba "0 resultados" y el perfil latino_first
# bajaba el inglés creyendo que no había latino.
#
# Devuelve los magnets si la página los tuviera (para poder bajarlos) y publica
# el estado en SITE_STATUS, que el bucle de stream adjunta al evento:
#   'site': {'published': bool|None, 'has_magnet': bool, 'ddl': [...], 'url': str}
# published=None significa "no se pudo comprobar" — el llamador sigue como antes.

CC_WEB = 'https://www.cinecalidad.am'
CC_DDL_HOSTS = (
    'megaup', 'mediafire', 'mega.nz', 'mega.co.nz', '1fichier', 'krakenfiles',
    'drive.google', 'ddownload', 'uploadhaven', 'gofile', 'pixeldrain', 'dood',
    'katfile', 'rapidgator', 'nitroflare', 'clicknupload', '1cloudfile',
)
SITE_STATUS = {}


def _cc_slug(text):
    return '-'.join(normalize_title(text).split())


_CC_SESSION = None


def _cc_session():
    """La web está detrás de Cloudflare: urllib a secas recibe 403, cloudscraper no."""
    global _CC_SESSION
    if _CC_SESSION is None:
        import cloudscraper
        _CC_SESSION = cloudscraper.create_scraper()
    return _CC_SESSION


def _cc_fetch(url, timeout=12):
    """Cloudscraper primero (la web está tras Cloudflare); un reintento porque la
    primera petición puede chocar con el resto de proveedores en paralelo."""
    for _ in range(2):
        try:
            r = _cc_session().get(url, timeout=timeout, headers={'Referer': f'{CC_WEB}/'})
            if r.status_code == 200 and len(r.text) > 4000:
                return r.text
        except Exception:
            pass
    try:
        page = http_get(url, timeout=timeout, referer=f'{CC_WEB}/')
        return page if page and len(page) > 4000 else None
    except Exception:
        return None


def _cc_slug_like(path, titles):
    """¿El slug/enlace corresponde al título buscado? (los resultados de la web
    traen publicidad y contenido relacionado primero)."""
    norm = normalize_title(path.replace('-', ' ').replace('/', ' '))
    for t in titles:
        nt = normalize_title(t)
        if nt and nt in norm:
            return True
    # Títulos traducidos de forma distinta (Demo2-ES vs Demo2-EN): similitud
    # alta en el slug, sólo cuando el título inglés no aparece literalmente.
    for t in titles:
        nt = normalize_title(t).replace(' ', '-')
        if len(nt) >= 5:
            import difflib
            if difflib.SequenceMatcher(None, nt, norm.replace(' ', '-')).ratio() >= 0.7:
                return True
    return False


def provider_cinecalidad_web(imdb_id, media_type, season=None, episode=None):
    """Mira la web de Cinecalidad: ¿el episodio/película ya está publicado?"""
    status = {'published': None, 'has_magnet': False, 'ddl': [], 'url': ''}
    SITE_STATUS['CinecalidadWeb'] = status
    results = []
    try:
        meta = resolve_metadata(imdb_id, media_type) or {}
        titles = [t for t in (meta.get('titles') or []) if t]
        if not titles:
            return results

        slugs = []
        for t in titles:
            s = _cc_slug(t)
            if s and s not in slugs:
                slugs.append(s)
        slugs = slugs[:3]

        is_ep = media_type == 'series' and season and episode
        urls = ([f'{CC_WEB}/ver-el-episodio/{s}-{int(season)}x{int(episode)}/' for s in slugs]
                if is_ep else
                [f'{CC_WEB}/ver-pelicula/{s}/' for s in slugs])

        html, used = None, ''
        for url in urls:
            page = _cc_fetch(url)
            if page:
                html, used = page, url
                break

        # Fallback: buscar el título en la web para descubrir el slug real
        if not html:
            for t in titles[:2]:
                page = _cc_fetch(f'{CC_WEB}/?s={urllib.parse.quote(t)}')
                if not page:
                    continue
                if is_ep:
                    ep_links = re.findall(r'"/ver-el-episodio/([^"\'?#]+)"', page)
                    direct = next((l for l in ep_links
                                   if re.search(r'[-_]%dx%d$' % (int(season), int(episode)), l)
                                   and _cc_slug_like(l, titles)), None)
                    if direct:
                        used = f'{CC_WEB}/ver-el-episodio/{direct}/'
                        html = _cc_fetch(used)
                    else:
                        s = next((l for l in re.findall(r'"/ver-serie/([^"\'?#]+)"', page)
                                  if _cc_slug_like(l, titles)), None)
                        if s:
                            used = f'{CC_WEB}/ver-el-episodio/{s}-{int(season)}x{int(episode)}/'
                            html = _cc_fetch(used)
                else:
                    m = next((l for l in re.findall(r'"/ver-pelicula/([^"\'?#]+)"', page)
                              if _cc_slug_like(l, titles)), None)
                    if m:
                        used = f'{CC_WEB}/ver-pelicula/{m}/'
                        html = _cc_fetch(used)
                if html:
                    break

        if not html:
            # No se pudo identificar la página: 'unknown' (None) — el llamador
            # sigue comportándose como antes (permitir el fallback a inglés).
            status['published'] = None
            return results

        magnets = MAGNET_RE.findall(html)
        torrent_links = re.findall(r'href="([^"]+\.torrent[^"]*)"', html, re.IGNORECASE)
        ddl = [h for h in CC_DDL_HOSTS if re.search(re.escape(h), html, re.IGNORECASE)]

        # True = la página existe y trae enlaces (torrent o descarga directa);
        # None = no se pudo comprobar (nunca False: un 404 puede ser "no emitido"
        # o "no lo encuentro", y la app no debe bloquear el inglés por eso).
        status['published'] = True if (magnets or torrent_links or ddl) else None
        status['has_magnet'] = bool(magnets or torrent_links)
        status['ddl'] = ddl
        status['url'] = used

        label = f'{titles[0]}'
        if is_ep:
            label += f' S{int(season):02d}E{int(episode):02d}'
        for mg in magnets:
            h = extract_info_hash(mg)
            if not h:
                continue
            size = ''
            m = re.search(r'💾\s*([\d.]+\s*[KMGT]B)', html)
            if m:
                size = m.group(1)
            results.append(format_result(f'{label} (web)', build_magnet(h, label), h, size, 'CC-WEB'))
    except Exception:
        return results
    return results


# ── Provider: Comet ─────────────────────────────────────

def provider_comet(imdb_id, media_type, season=None, episode=None):
    """Scrape torrents via Comet Stremio addon."""
    results = []

    if media_type == 'movie':
        path = f'stream/movie/{imdb_id}.json'
    else:
        if not season or not episode:
            return []
        path = f'stream/series/{imdb_id}:{season}:{episode}.json'

    url = f'{COMET_BASE}/{path}'
    try:
        data = http_get_json(url, timeout=25)
        streams = data.get('streams', [])
    except Exception:
        return results

    for s in streams:
        info_hash = (s.get('infoHash') or '').lower()
        direct_url = s.get('url', '')
        description = s.get('description', '') or ''

        # Skip obsolete-config / error marker streams (they link to the addon homepage)
        marker = (s.get('name', '') + ' ' + description).lower()
        if 'obsolete configuration' in marker or 're-configure' in marker:
            continue

        # Filename
        filename = (s.get('behaviorHints', {}).get('filename')
                    or info_hash or '')
        if (not filename or filename == info_hash) and description:
            m = re.search(r'📄\s*([^\n]+)', description)
            if m:
                filename = m.group(1).strip()

        # Size
        size = ''
        if description:
            size_match = re.search(r'💾\s*([\d.]+\s*[KMGT]B)', description, re.IGNORECASE)
            if size_match:
                size = size_match.group(1)

        # Debrid cached streams (have directUrl, no infoHash)
        if not info_hash and direct_url:
            results.append({
                'title': filename,
                'size': size or '0 B',
                'seeders': -1,
                'peers': -1,
                'link': direct_url,
                'indexer': 'Comet',
                'info_hash': None,
            })
            continue

        if not info_hash:
            continue

        magnet = build_magnet(info_hash, filename)
        results.append(format_result(filename, magnet, info_hash, size, 'Comet'))

    return results


# ── Main ────────────────────────────────────────────────

def run_all(imdb_id, media_type, season=None, episode=None):
    """Run all 3 providers in parallel and collect results."""
    all_results = []

    providers = {
        'TCL': provider_tcl,
        'Cinecalidad': provider_cinecalidad,
        'Comet': provider_comet,
    }

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(fn, imdb_id, media_type, season, episode): name
            for name, fn in providers.items()
        }

        for future in concurrent.futures.as_completed(futures, timeout=30):
            name = futures[future]
            try:
                results = future.result(timeout=25)
                all_results.extend(results)
            except Exception:
                pass

    # La web se consulta FUERA del pool: compartir cloudscraper con los otros
    # proveedores en paralelo hace que Cloudflare devuelva 403 y el chequeo
    # fallaría (verificado). Secuencial = determinista.
    try:
        all_results.extend(provider_cinecalidad_web(imdb_id, media_type, season, episode))
    except Exception:
        pass

    return all_results


def main():
    args = sys.argv[1:]
    stream_mode = '--stream' in args
    clean_args = [a for a in args if not a.startswith('--')]

    if len(clean_args) < 2:
        print(json.dumps({'error': 'Usage: latino-providers.py <imdb_id> <type> [season] [episode]'}))
        sys.exit(1)

    imdb_id = clean_args[0]
    media_type = clean_args[1]  # 'movie' or 'series'
    season = clean_args[2] if len(clean_args) > 2 else None
    episode = clean_args[3] if len(clean_args) > 3 else None

    if media_type == 'series' and (not season or not episode):
        print(json.dumps({'error': 'Season and episode required for series'}))
        sys.exit(1)

    if stream_mode:
        # Stream mode: emit JSON lines per provider
        providers = {
            'TCL': provider_tcl,
            'Cinecalidad': provider_cinecalidad,
            'Comet': provider_comet,
        }
        all_results = []

        for name in providers:
            print(json.dumps({'type': 'provider_start', 'provider': name}), flush=True)
        print(json.dumps({'type': 'provider_start', 'provider': 'CinecalidadWeb'}), flush=True)

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(fn, imdb_id, media_type, season, episode): name
                for name, fn in providers.items()
            }

            for future in concurrent.futures.as_completed(futures, timeout=30):
                name = futures[future]
                try:
                    results = future.result(timeout=25)
                    all_results.extend(results)
                    print(json.dumps({
                        'type': 'provider_results',
                        'provider': name,
                        'results': results,
                    }), flush=True)
                except Exception:
                    print(json.dumps({
                        'type': 'provider_results',
                        'provider': name,
                        'results': [],
                    }), flush=True)

        # ── Chequeo de la WEB de Cinecalidad (fuera del pool) ──────────────
        # El índice del addon sólo lista torrents; la web publica el episodio
        # antes como descarga directa. El grabber usa este 'site' para NO caer
        # a inglés cuando el latino ya está publicado (sólo como DDL).
        try:
            site_results = provider_cinecalidad_web(imdb_id, media_type, season, episode)
        except Exception:
            site_results = []
        all_results.extend(site_results)
        site_payload = {
            'type': 'provider_results',
            'provider': 'CinecalidadWeb',
            'results': site_results,
        }
        if 'CinecalidadWeb' in SITE_STATUS:
            site_payload['site'] = SITE_STATUS['CinecalidadWeb']
        print(json.dumps(site_payload), flush=True)

        print(json.dumps({'type': 'done', 'total': len(all_results)}), flush=True)
    else:
        results = run_all(imdb_id, media_type, season, episode)
        print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
