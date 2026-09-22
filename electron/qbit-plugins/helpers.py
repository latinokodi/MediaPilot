"""
Shim for qBittorrent's helpers module.
Provides retrieve_url() and download_file() backed by:

1. cloudscraper (fast, handles mild Cloudflare)
2. FlareSolverr proxy at localhost:8191 (handles heavy Cloudflare like 1337x)
3. Plain requests (fallback)

No Docker, no external installs — FlareSolverr is bundled with the app.
"""

import sys
import os
import json
import time
from typing import Optional
from urllib.parse import urlparse

# ── FlareSolverr config ────────────────────────────────
FLARESOLVERR_URL = os.environ.get('FLARESOLVERR_URL', 'http://localhost:8191')
_FLARESOLVERR_AVAILABLE = None  # cached: None=unknown, True/False

# ── CF cookie file (backward compat) ────────────────────
_CF_COOKIE_FILE = os.environ.get('CF_COOKIE_FILE', '')
_cf_cookies: dict = {}
_cf_cookies_loaded = False


def _load_cf_cookies() -> dict:
    global _cf_cookies, _cf_cookies_loaded
    if _cf_cookies_loaded:
        return _cf_cookies
    _cf_cookies_loaded = True
    if _CF_COOKIE_FILE and os.path.exists(_CF_COOKIE_FILE):
        try:
            with open(_CF_COOKIE_FILE, 'r', encoding='utf-8') as f:
                _cf_cookies = json.load(f)
        except Exception:
            pass
    return _cf_cookies


def _get_cf_cookies_for_url(url: str) -> dict:
    _load_cf_cookies()
    hostname = urlparse(url).hostname or ''
    cookies = _cf_cookies.get(hostname, [])
    return {c['name']: c['value'] for c in cookies if c.get('name') and c.get('value')}


# ── cloudscraper ────────────────────────────────────────
try:
    import cloudscraper
    _scraper = cloudscraper.create_scraper(
        browser={
            'custom': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        },
        delay=0.5,
    )
    _HAS_CLOUDSCRAPER = True
except ImportError:
    _scraper = None
    _HAS_CLOUDSCRAPER = False

# ── plain requests ──────────────────────────────────────
try:
    import requests as _requests
    _session = _requests.Session()
    _session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    })
    _HAS_REQUESTS = True
except ImportError:
    _session = None
    _HAS_REQUESTS = False

# ── Side-effect sentinel ────────────────────────────────
htmlentitydecode = "sentinel"

# ── Electron CF Bridge ──────────────────────────────────
_ELECTRON_CF_PORT = os.environ.get('ELECTRON_CF_PORT', '')
_ELECTRON_CF_URL = f'http://127.0.0.1:{_ELECTRON_CF_PORT}/fetch' if _ELECTRON_CF_PORT else ''


def _fetch_via_electron(url: str) -> Optional[str]:
    """Fetch a URL through Electron's native Chromium (handles CF natively)."""
    if not _ELECTRON_CF_URL or not _HAS_REQUESTS or _session is None:
        return None

    try:
        resp = _session.post(
            _ELECTRON_CF_URL,
            json={'url': url},
            timeout=65,
        )
        if resp.status_code == 200:
            data = resp.json()
            html = data.get('html', '')
            if html and not _is_cf_challenge(html):
                return html
        return None
    except Exception:
        return None


def _is_cf_challenge(text: str) -> bool:
    """Check if the response is a Cloudflare challenge page."""
    if not text or len(text) < 200:
        return False
    lower = text[:500].lower()
    return any(indicator in lower for indicator in [
        'just a moment',
        'checking your browser',
        'cf-browser-verification',
        'cf-challenge-running',
        '#challenge-running',
    ])


def _fetch_via_flaresolverr(url: str) -> Optional[str]:
    """Fetch a URL through the FlareSolverr proxy."""
    global _FLARESOLVERR_AVAILABLE

    if _FLARESOLVERR_AVAILABLE is False:
        return None

    if not _HAS_REQUESTS or _session is None:
        _FLARESOLVERR_AVAILABLE = False
        return None

    try:
        resp = _session.post(
            f'{FLARESOLVERR_URL}/v1',
            json={
                'cmd': 'request.get',
                'url': url,
                'maxTimeout': 60000,
            },
            timeout=65,
        )
        data = resp.json()
        if data.get('status') == 'ok' and data.get('solution', {}).get('status') == 200:
            _FLARESOLVERR_AVAILABLE = True
            return data['solution']['response']
        else:
            # FlareSolverr responded but couldn't fetch (site down, etc.)
            # Don't mark as unavailable — other sites may still work
            return None
    except _requests.exceptions.ConnectionError:
        # FlareSolverr is genuinely unreachable
        _FLARESOLVERR_AVAILABLE = False
        return None
    except Exception:
        # Timeout or other transient error — don't disable FlareSolverr
        return None


def _fetch_with_cloudscraper(url: str, data: Optional[bytes] = None) -> str:
    cf_cookies = _get_cf_cookies_for_url(url)
    kwargs = {'timeout': 30}
    if cf_cookies:
        kwargs['cookies'] = cf_cookies
    if data:
        resp = _scraper.post(url, data=data, **kwargs)
    else:
        resp = _scraper.get(url, **kwargs)
    resp.raise_for_status()
    return resp.text


def _fetch_with_requests(url: str, data: Optional[bytes] = None) -> str:
    cf_cookies = _get_cf_cookies_for_url(url)
    kwargs = {'timeout': 30}
    if cf_cookies:
        kwargs['cookies'] = cf_cookies
    if data:
        resp = _session.post(url, data=data, **kwargs)
    else:
        resp = _session.get(url, **kwargs)
    resp.raise_for_status()
    return resp.text


def retrieve_url(url: str, request_data: Optional[bytes] = None) -> str:
    """
    Fetch a URL and return its text content.

    Strategy: cloudscraper → Electron bridge → FlareSolverr → requests
    """
    result = None

    # 1. Try cloudscraper (fast, handles most sites)
    if _HAS_CLOUDSCRAPER and _scraper is not None:
        try:
            result = _fetch_with_cloudscraper(url, request_data)
            if not _is_cf_challenge(result):
                return result
            # Got CF challenge — try Electron bridge
        except Exception:
            pass

    # 2. If cloudscraper gave us a CF page, try Electron's native Chromium
    if result and _is_cf_challenge(result):
        el_result = _fetch_via_electron(url)
        if el_result is not None:
            return el_result

    # 3. Try FlareSolverr (headless Chrome with undetected-chromedriver)
    if result is None or _is_cf_challenge(result):
        fs_result = _fetch_via_flaresolverr(url)
        if fs_result is not None:
            return fs_result

    # 4. Fallback: plain requests
    if _HAS_REQUESTS and _session is not None:
        try:
            return _fetch_with_requests(url, request_data)
        except Exception:
            pass

    # 5. Everything failed
    if result and not _is_cf_challenge(result):
        return result  # return whatever we got from cloudscraper

    raise RuntimeError(
        f"Failed to fetch {url}. "
        f"cloudscraper={'available' if _HAS_CLOUDSCRAPER else 'missing'}, "
        f"electron={'available' if _ELECTRON_CF_URL else 'missing'}, "
        f"flaresolverr={'available' if _FLARESOLVERR_AVAILABLE else 'unavailable'}, "
        f"requests={'available' if _HAS_REQUESTS else 'missing'}"
    )


def download_file(url: str) -> str:
    """Return the URL itself — TorBox handles actual downloads."""
    return url
