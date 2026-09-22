# VERSION: 1.3
# AUTHORS: TorDownloader Latino Pack
# SITE: wolfmax4k.com - Spanish torrents (movies, series, docs)
#
# JSON search API at /mvc/controllers/data.find.php — no anti-bot needed.
# Uses urllib directly since the API endpoint accepts plain POST requests.

import re
import json
import urllib.request
import urllib.parse
from helpers import retrieve_url
from novaprinter import prettyPrinter


class wolfmax4k:
    url = 'https://wolfmax4k.com'
    name = 'Wolfmax4k'

    supported_categories = {
        'all': '0',
        'movies': '1',
        'tv': '6',
    }

    def _get_token(self):
        """Extract CSRF token from search page."""
        try:
            html = retrieve_url(f'{self.url}/buscar')
            match = re.search(r'name="token"\s+value="([^"]+)"', html)
            if match:
                return match.group(1)
        except Exception:
            pass
        return ''

    def _api_search(self, query, cidr='0', page='1'):
        """Call JSON search API via POST."""
        token = self._get_token()
        if not token:
            return []

        post_body = urllib.parse.urlencode({
            '_ACTION': 'buscar',
            'token': token,
            'q': query,
            'cidr': cidr,
            'c': '0',
            'l': '100',
            'pg': str(page),
        }).encode()

        try:
            req = urllib.request.Request(
                f'{self.url}/mvc/controllers/data.find.php',
                data=post_body,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': f'{self.url}/buscar',
                }
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())

            if not data.get('response'):
                return []
            return data.get('data', {}).get('datafinds', {}).get('0', {})
        except Exception:
            return []

    def search(self, what, cat='all'):
        # qbit-runner replaces spaces with %20 — undo that
        what = what.replace('%20', ' ')
        
        cidr_map = {'all': '0', 'movies': '1', 'tv': '6'}
        cidr = cidr_map.get(cat, '0')

        results = self._api_search(what, cidr=cidr)
        # Fall back to individual words if multi-word query returns nothing
        if not results and ' ' in what:
            words = [w for w in what.split() if len(w) > 2]
            seen_guids = set()
            combined = {}
            idx = 0
            for word in words:
                batch = self._api_search(word, cidr=cidr)
                for k, v in batch.items():
                    guid = v.get('guid', '')
                    if guid and guid not in seen_guids:
                        seen_guids.add(guid)
                        combined[str(idx)] = v
                        idx += 1
            results = combined
        if not results:
            return

        for idx in sorted(results.keys(), key=lambda k: int(k) if k.isdigit() else 0):
            item = results[idx]
            guid = item.get('guid', '')
            name = item.get('torrentName', '')
            calidad = item.get('calidad', '')

            if not guid or not name:
                continue

            detail_url = f'{self.url}/{guid}'

            prettyPrinter({
                'link': detail_url,
                'name': f'{name} [{calidad}]' if calidad else name,
                'size': '0 B',
                'seeds': -1,
                'leech': -1,
                'engine_url': self.url,
                'desc_link': detail_url,
            })
