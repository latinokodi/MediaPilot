# VERSION: 1.3
# AUTHORS: TorDownloader Latino Pack
# SITE: Cinecalidad — Mexican/Latino movies & series
#
# Official domain: cinecalidad.am (verify via t.me/cinecalidadofficial)
# Primarily streaming with direct downloads. Torrent links when available.

import re
import json
import urllib.request
from helpers import retrieve_url
from novaprinter import prettyPrinter

HTML_TAG = re.compile(r'<[^>]+>')
MAGNET_RE = re.compile(r'href="(magnet:\?[^"]+)"', re.IGNORECASE)
TORRENT_RE = re.compile(r'href="([^"]+\.torrent[^"]*)"', re.IGNORECASE)


class cinecalidad:
    url = 'https://cinecalidad.am'
    name = 'Cinecalidad'
    # Verify current domain at: https://t.me/cinecalidadofficial

    supported_categories = {
        'all': '',
        'movies': 'peliculas',
        'tv': 'series',
    }

    def search(self, what, cat='all'):
        query = what.replace(' ', '+')

        # Try WordPress REST API
        posts = []
        for post_type in ('posts', 'pages'):
            try:
                api_url = f'{self.url}/wp-json/wp/v2/{post_type}?search={query}&per_page=30&_fields=id,link,title,content'
                req = urllib.request.Request(api_url, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                })
                with urllib.request.urlopen(req, timeout=10) as r:
                    results = json.loads(r.read())
                    if results:
                        posts.extend(results)
            except Exception:
                continue

        if not posts:
            return

        for post in posts:
            title = HTML_TAG.sub('', post.get('title', {}).get('rendered', '')).strip()
            detail_url = post.get('link', '')
            content = post.get('content', {}).get('rendered', '')

            if not title or not detail_url:
                continue

            # Try magnet first, then .torrent, fallback to detail page
            m = MAGNET_RE.search(content)
            if m:
                link = m.group(1)
            else:
                m = TORRENT_RE.search(content)
                if m:
                    link = m.group(1)
                    if not link.startswith('http'):
                        link = self.url.rstrip('/') + '/' + link.lstrip('/')
                else:
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
