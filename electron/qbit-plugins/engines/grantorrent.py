# VERSION: 1.3
# AUTHORS: TorDownloader Latino Pack
# SITE: grantorrent — Spanish/Latino torrents (movies, series)
#
# Uses WordPress REST API at /wp-json/wp/v2/pages?search=

import re
import json
import urllib.request
import urllib.parse
from helpers import retrieve_url
from novaprinter import prettyPrinter

MAGNET_RE = re.compile(r'href="(magnet:\?[^"]+)"', re.IGNORECASE)
TORRENT_RE = re.compile(r'href="([^"]+\.torrent[^"]*)"', re.IGNORECASE)
HTML_TAG = re.compile(r'<[^>]+>')


class grantorrent:
    url = 'https://grantorrent.foo'
    name = 'GranTorrent'
    _domains = ['https://grantorrent.foo', 'https://grantorrent.wtf', 'https://grantorrent.quest']

    supported_categories = {
        'all': 'pages',
        'movies': 'pages',  # WP API doesn't filter by category easily
        'tv': 'pages',
    }

    def _api_search(self, query, per_page=30):
        """Search via WordPress REST API."""
        params = urllib.parse.urlencode({
            'search': query,
            'per_page': str(per_page),
            '_fields': 'id,link,title,content',
        })
        api_url = f'{self.url}/wp-json/wp/v2/pages?{params}'

        try:
            req = urllib.request.Request(api_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read())
        except Exception:
            return []

    def _find_link(self, content, detail_url):
        """Extract magnet or torrent link from content HTML."""
        # Try magnet first
        m = MAGNET_RE.search(content)
        if m:
            return m.group(1)
        # Try .torrent file
        m = TORRENT_RE.search(content)
        if m:
            url = m.group(1)
            if url.startswith('/'):
                url = self.url.rstrip('/') + '/' + url.lstrip('/')
            elif not url.startswith('http'):
                url = 'https:' + url
            return url
        # Fallback to detail page
        return detail_url

    def search(self, what, cat='all'):
        # qbit-runner replaces spaces with %20 — undo that
        what = what.replace('%20', ' ')
        
        # Try full query first, then individual words if no results
        results = self._api_search(what)
        if not results and ' ' in what:
            words = [w for w in what.split() if len(w) > 2]
            seen_ids = set()
            combined = []
            for word in words:
                batch = self._api_search(word, per_page=10)
                for post in batch:
                    pid = post.get('id')
                    if pid and pid not in seen_ids:
                        seen_ids.add(pid)
                        combined.append(post)
            results = combined
        if not results:
            return

        for post in results:
            title_html = post.get('title', {}).get('rendered', '')
            title = HTML_TAG.sub('', title_html).strip()
            detail_url = post.get('link', '')
            content = post.get('content', {}).get('rendered', '')

            if not title or not detail_url:
                continue

            link = self._find_link(content, detail_url)

            prettyPrinter({
                'link': link,
                'name': title,
                'size': '0 B',
                'seeds': -1,
                'leech': -1,
                'engine_url': self.url,
                'desc_link': detail_url,
            })
