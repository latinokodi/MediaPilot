"""
Shim for qBittorrent's novaprinter module.
Replaces prettyPrinter() to capture results into a per-thread list
instead of printing to stdout in qBittorrent's wire format.

Per-thread isolation is required: qbit-runner.py searches engines
concurrently (ThreadPoolExecutor), and a module-global list would
race — engines would read each other's results.
"""

import threading

_local = threading.local()


def _results() -> list:
    if not hasattr(_local, 'results'):
        _local.results = []
    return _local.results


def prettyPrinter(data: dict) -> None:
    """Capture a search result dict into this thread's results list."""
    _results().append(dict(data))


def clear_results() -> None:
    """Reset this thread's results accumulator."""
    _results().clear()


def get_results() -> list:
    """Return all results captured by this thread."""
    return list(_results())


def anySizeToBytes(size_string: str) -> int:
    """Convert a size string (e.g. '1.5 GB', '500 MB') to bytes.

    This is a standard function provided by qBittorrent's novaprinter.
    Many community plugins depend on it.
    """
    size_string = size_string.strip().upper()
    if not size_string:
        return -1

    # Split into value and unit
    parts = size_string.split()
    if len(parts) < 1:
        return -1

    try:
        value = float(parts[0])
    except ValueError:
        return -1

    if len(parts) >= 2:
        unit = parts[1]
    else:
        unit = 'B'  # Assume bytes if no unit

    multipliers = {
        'B': 1,
        'KB': 1024,
        'KIB': 1024,
        'MB': 1024 ** 2,
        'MIB': 1024 ** 2,
        'GB': 1024 ** 3,
        'GIB': 1024 ** 3,
        'TB': 1024 ** 4,
        'TIB': 1024 ** 4,
    }
    multiplier = multipliers.get(unit.replace('YTES', '').strip(), 1)  # handle 'BYTES' → 'B'
    return int(value * multiplier)


class SearchResults(dict):
    """qBittorrent SearchResults placeholder.
    Some community plugins create instances of this class.
    It behaves like a dict but also supports attribute access.
    """
    def __getattr__(self, name):
        if name in self:
            return self[name]
        raise AttributeError(f"'SearchResults' has no attribute '{name}'")

    def __setattr__(self, name, value):
        self[name] = value
