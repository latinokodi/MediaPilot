# VERSION: 1.2
# AUTHORS: TorDownloader Latino Pack
# SITE: EliteTorrent — Spanish torrents (movies, series, games)
#
# WordPress with Cloudflare. Falls back to FlareSolverr on :8191 when available.

import re
import json
import urllib.request
from helpers import retrieve_url
from novaprinter import prettyPrinter


def _try_flaresolverr(url):
    try:
        req = urllib.request.Request('http://localhost:8191/v1',
            data=json.dumps({'cmd': 'request.get', 'url': url, 'maxTimeout': 30000}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=35) as r:
            data = json.loads(r.read())
            if data.get('status') == 'ok':
                return data['solution']['response']
    except Exception:
        pass
    return None


def _smart_fetch(url):
    """Try FlareSolverr first for FingerprintJS-protected sites, 
    fall back to retrieve_url if FlareSolverr unavailable."""
    fs = _try_flaresolverr(url)
    if fs:
        return fs
    try:
        return retrieve_url(url)
    except Exception:
        pass
    return ''


class elitetorrent:
    url = 'https://elitetorrent.nl'
    name = 'EliteTorrent'

    supported_categories = {
        'all': '',
        'movies': 'peliculas',
        'tv': 'series',
        'games': 'juegos',
        'music': 'musica',
    }

    def search(self, what, cat='all'):
        query = what.replace(' ', '+')
        search_url = f'{self.url}/?s={query}'

        html = _smart_fetch(search_url)
        if not html or len(html) < 500:
            return

        seen = set()
        for match in re.finditer(
            r'<a\s[^>]*href="([^"]*(?:/torrent/|/pelicula/|/descargar/|/serie/|/juego/)[^"]*)"[^>]*>(.*?)</a>',
            html, re.IGNORECASE | re.DOTALL
        ):
            link = match.group(1)
            title = re.sub(r'<[^>]+>', '', match.group(2)).strip()
            if not link.startswith('http'):
                link = self.url.rstrip('/') + '/' + link.lstrip('/')
            if link not in seen and title:
                seen.add(link)
                prettyPrinter({
                    'link': link,
                    'name': title,
                    'size': '0 B',
                    'seeds': -1,
                    'leech': -1,
                    'engine_url': self.url,
                    'desc_link': link,
                })
