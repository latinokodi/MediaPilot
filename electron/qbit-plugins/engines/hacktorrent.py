# VERSION: 1.0
# AUTHORS: TorDownloader Latino Pack
# SITE: hacktorrent.cc — Spanish/Latino torrents via WordPress REST API

import json
import urllib.request
import urllib.parse
from novaprinter import prettyPrinter

HTML_TAG = __import__('re').compile(r'<[^>]+>')


class hacktorrent:
    url = 'https://hacktorrent.cc'
    name = 'HackTorrent'

    supported_categories = {
        'all': 'all',
        'movies': 'pelicula',
        'tv': 'serie',
    }

    def _api_search(self, query, content_type='all', page=1):
        params = urllib.parse.urlencode({
            'query': query, 'type': content_type, 'page': str(page),
        })
        try:
            req = urllib.request.Request(
                f'{self.url}/wp-json/wpreact/v1/search?{params}',
                headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                         'Referer': f'{self.url}/'}
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read()).get('results', [])
        except Exception:
            return []

    def search(self, what, cat='all'):
        what = what.replace('%20', ' ')
        ct = self.supported_categories.get(cat, 'all')
        results = self._api_search(what, ct)

        if not results and ' ' in what:
            words = [w for w in what.split() if len(w) > 2]
            seen = set()
            combined = []
            for w in words:
                for item in self._api_search(w, ct):
                    iid = item.get('id')
                    if iid and iid not in seen:
                        seen.add(iid)
                        combined.append(item)
            results = combined

        for item in results:
            slug = item.get('slug', '')
            title = HTML_TAG.sub('', item.get('title', '')).strip()
            if not slug or not title:
                continue
            detail_url = f'{self.url}/{slug}/'
            prettyPrinter({
                'link': detail_url,
                'name': title,
                'size': '0 B',
                'seeds': -1,
                'leech': -1,
                'engine_url': self.url,
                'desc_link': detail_url,
            })
