#!/usr/bin/env python3
"""
qbit-runner.py — Metasearch bridge for TorDownloader Electron.

Usage: python qbit-runner.py "<search query>"

Loads all qBittorrent search plugins from engines/, runs each plugin's
search() method against the query, collects results via novaprinter shim,
deduplicates by info_hash, and outputs JSON to stdout.

Exit codes:
  0 — success (results in stdout, possibly empty array)
  1 — usage error (no query provided)
  2 — plugin loading failure
  3 — all plugins failed
"""

import sys
import json
import os
import re
import traceback
import concurrent.futures
from typing import Optional

# ── Ensure the plugins directory is on sys.path ─────────
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINES_DIR = os.path.join(PLUGIN_DIR, 'engines')

# User plugins directory (updated plugins take priority)
USER_PLUGINS_DIR = os.environ.get('USER_PLUGINS_DIR', '')
if USER_PLUGINS_DIR and not os.path.isdir(USER_PLUGINS_DIR):
    USER_PLUGINS_DIR = ''

sys.path.insert(0, PLUGIN_DIR)

# Import our shims — these replace qBittorrent's runtime
import novaprinter  # noqa: E402


def extract_info_hash(magnet_or_url: str) -> Optional[str]:
    """Extract BTIH from a magnet link."""
    if not magnet_or_url:
        return None
    m = re.search(r'btih:([a-fA-F0-9]{40})', magnet_or_url)
    if m:
        return m.group(1).lower()
    m = re.search(r'btih:([a-zA-Z2-7]{32})', magnet_or_url)
    if m:
        return m.group(1).lower()
    return None


def normalize_result(raw: dict) -> Optional[dict]:
    """
    Convert a qBittorrent plugin result dict into TorDownloader's format:
    {title, size, seeders, peers, link, indexer, info_hash}
    """
    link = raw.get('link', '')
    name = raw.get('name', 'Unknown')

    if not link or not name:
        return None

    # Skip error-page "results" some engines emit when nothing matches
    name_lower = str(name).lower()
    if any(x in name_lower for x in (
        'no se encontraron resultados',
        'no se han encontrado resultados',
        'no results found',
        'no results were found',
    )):
        return None

    info_hash = extract_info_hash(link)

    # Parse size — can be '1.5 GB', '1500000000 B', or '-1'
    size_str = str(raw.get('size', '0'))
    size_display = size_str
    try:
        size_bytes = int(size_str.replace(' B', '').strip())
        if size_bytes > 0:
            if size_bytes >= 1024**3:
                size_display = f"{size_bytes / 1024**3:.1f} GB"
            elif size_bytes >= 1024**2:
                size_display = f"{size_bytes / 1024**2:.1f} MB"
            elif size_bytes >= 1024:
                size_display = f"{size_bytes / 1024:.1f} KB"
            else:
                size_display = f"{size_bytes} B"
    except (ValueError, AttributeError):
        pass

    # Parse seeds/leeches
    try:
        seeds = int(raw.get('seeds', 0))
    except (ValueError, TypeError):
        seeds = 0
    try:
        leech = int(raw.get('leech', 0))
    except (ValueError, TypeError):
        leech = 0

    indexer = raw.get('engine_url', '')

    return {
        'title': str(name),
        'size': size_display,
        'seeders': max(0, seeds),
        'peers': max(0, leech),
        'link': str(link),
        'indexer': str(indexer),
        'info_hash': info_hash,
    }


def load_plugin(engine_file: str, source_dir: str = ENGINES_DIR) -> Optional[tuple]:
    """
    Import a plugin module and return (short_name, plugin_instance).
    Returns None if loading fails for any reason.
    """
    module_name = os.path.splitext(engine_file)[0]
    if module_name.startswith('_') or module_name == 'versions':
        return None

    try:
        # Dynamic import
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            module_name,
            os.path.join(source_dir, engine_file)
        )
        if spec is None or spec.loader is None:
            print(f"[debug] {engine_file}: spec is None", file=sys.stderr)
            return None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except Exception as e:
        print(f"[debug] {engine_file}: LOAD ERROR {type(e).__name__}: {e}", file=sys.stderr)
        return None

    # Find the plugin class (the one with .search method and .url attribute)
    for attr_name in dir(mod):
        if attr_name.startswith('_'):
            continue
        obj = getattr(mod, attr_name)
        if not isinstance(obj, type):
            continue
        if not hasattr(obj, 'search') or not hasattr(obj, 'url'):
            continue
        try:
            instance = obj()
            return (attr_name, instance)
        except Exception:
            continue

    return None


def run_plugin(name: str, plugin, query: str) -> list:
    """Run a single plugin's search and return list of normalized results."""
    try:
        novaprinter.clear_results()
        plugin.search(query.replace(' ', '%20'))
        raw_results = novaprinter.get_results()

        normalized = []
        for raw in raw_results:
            norm = normalize_result(raw)
            if norm:
                normalized.append(norm)
        return normalized
    except Exception:
        return []


def deduplicate(results: list) -> list:
    """Deduplicate by info_hash, keeping the entry with highest seeders."""
    seen: dict = {}
    for r in results:
        key = r['info_hash'] or r['link']
        if key is None:
            continue
        if key not in seen or r['seeders'] > seen[key]['seeders']:
            seen[key] = r
    return sorted(seen.values(), key=lambda x: x['seeders'], reverse=True)


def main():
    args = sys.argv[1:]
    stream_mode = '--stream' in args

    # Filter out flags to get the query
    query_args = [a for a in args if not a.startswith('--')]
    if not query_args or not query_args[0].strip():
        print(json.dumps([]))
        sys.exit(0)

    query = query_args[0].strip()

    # Discover plugins
    if not os.path.isdir(ENGINES_DIR):
        print(json.dumps([], indent=2))
        sys.exit(0)

    engine_files = sorted(f for f in os.listdir(ENGINES_DIR) if f.endswith('.py'))

    # Prepend user plugins (they override bundled ones of the same name)
    if USER_PLUGINS_DIR:
        user_files = sorted(f for f in os.listdir(USER_PLUGINS_DIR) if f.endswith('.py'))
        engine_files = user_files + [f for f in engine_files if f not in set(user_files)]

    # Load all plugins
    plugins = []
    for ef in engine_files:
        user_path = os.path.join(USER_PLUGINS_DIR, ef) if USER_PLUGINS_DIR else None
        source_dir = USER_PLUGINS_DIR if (user_path and os.path.exists(user_path)) else ENGINES_DIR
        if source_dir not in sys.path:
            sys.path.insert(0, source_dir)
        result = load_plugin(ef, source_dir)
        if result:
            plugins.append(result)

    if not plugins:
        print(json.dumps([], indent=2))
        sys.exit(0)

    # Run searches in parallel with a timeout per plugin
    all_results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(plugins), 8)) as executor:
        futures = {
            executor.submit(run_plugin, name, plugin, query): (name, plugin)
            for name, plugin in plugins
        }

        if stream_mode:
            # Stream mode: output JSON lines as each engine completes
            # Send engine_start for all engines first
            for name, _plugin in plugins:
                line = json.dumps({'type': 'engine_start', 'engine': name})
                print(line, flush=True)

        try:
            for future in concurrent.futures.as_completed(futures, timeout=45):
                name, _plugin = futures[future]
                try:
                    results = future.result(timeout=30)
                    all_results.extend(results)

                    if stream_mode:
                        # Emit results immediately for this engine
                        line = json.dumps({
                            'type': 'engine_results',
                            'engine': name,
                            'results': results,
                        })
                        print(line, flush=True)
                except (concurrent.futures.TimeoutError, Exception):
                    if stream_mode:
                        line = json.dumps({
                            'type': 'engine_results',
                            'engine': name,
                            'results': [],
                        })
                        print(line, flush=True)
        except TimeoutError:
            # Some plugins are still running — collect results from completed ones
            pass

    # Deduplicate and output
    final = deduplicate(all_results)

    if stream_mode:
        done_line = json.dumps({'type': 'done', 'total': len(final)})
        print(done_line, flush=True)
    else:
        print(json.dumps(final, indent=2))


if __name__ == '__main__':
    main()
