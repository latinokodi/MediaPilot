# VERSION: 1.3
# AUTHORS: TorDownloader Latino Pack
# SITE: mejortorrent — Spanish/Latino torrents (movies, series)
#
# Cloudflare Turnstile protected. Needs FlareSolverr or Electron bridge.
# Current domain: www43.mejortorrent.eu (verify via t.me/MejorTorrentAp)

import re
import json
import urllib.request
from helpers import retrieve_url
from novaprinter import prettyPrinter


def _try_flaresolverr(url):
    """Fetch through FlareSolverr on localhost:8191."""
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


class mejortorrent:
    url = 'https://www43.mejortorrent.eu'
    name = 'MejorTorrent'
    # Verify current domain at: https://t.me/MejorTorrentAp

    supported_categories = {
        'all': '',
        'movies': 'peliculas',
        'tv': 'series',
    }

    def search(self, what, cat='all'):
        # Try WordPress REST API first (fast)
        query = what.replace(' ', '+')
        try:
            api_url = f'{self.url}/wp-json/wp/v2/pages?search={query}&per_page=30&_fields=id,link,title,content'
            req = urllib.request.Request(api_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            with urllib.request.urlopen(req, timeout=10) as r:
                posts = json.loads(r.read())
        except Exception:
            # REST API blocked — try FlareSolverr
            html = _try_flaresolverr(f'{self.url}/?s={query}')
            if not html:
                return
            # Extract links from HTML
            posts = []
            for m in re.finditer(
                r'<a\s[^>]*href="([^"]*(?:/torrent/|/pelicula/|/descargar/)[^"]*)"[^>]*>\s*(?:<h\d[^>]*>)?(.*?)(?:</h\d>)?\s*</a>',
                html, re.IGNORECASE | re.DOTALL
            ):
                link = m.group(1)
                title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
                if not link.startswith('http'):
                    link = self.url.rstrip('/') + '/' + link.lstrip('/')
                posts.append({
                    'link': link,
                    'title': {'rendered': title},
                    'content': {'rendered': ''},
                })

        if not posts:
            return

        TAG_RE = re.compile(r'<[^>]+>')
        MAGNET_RE = re.compile(r'href="(magnet:\?[^"]+)"', re.IGNORECASE)
        TORRENT_RE = re.compile(r'href="([^"]+\.torrent[^"]*)"', re.IGNORECASE)

        for post in posts:
            title = TAG_RE.sub('', post.get('title', {}).get('rendered', '')).strip()
            detail_url = post.get('link', '')
            content = post.get('content', {}).get('rendered', '')
            if not title or not detail_url:
                continue

            # Extract magnet/torrent link
            m = MAGNET_RE.search(content)
            link = m.group(1) if m else None
            if not link:
                m = TORRENT_RE.search(content)
                if m:
                    link = m.group(1)
                    if not link.startswith('http'):
                        link = self.url.rstrip('/') + '/' + link.lstrip('/')
            if not link:
                link = detail_url

            prettyPrinter({
                'link': link,
                'name': title,
                'size': '0 B',
                'seeds': -1,
                'leech': -1,
                'engine_url': self.url,
                'desc_link': detail_url,
            })
