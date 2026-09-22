/**
 * Minimal same-origin HTTP helper for web-mode features (watchlist,
 * dashboard, monitor). The desktop Electron build has no backend on the
 * page origin, so these calls fail there — components surface that as a
 * toast instead of crashing.
 */
export async function http<T = any>(path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return (await res.json().catch(() => ({}))) as T
}

export function isWebMode(): boolean {
  return typeof window !== 'undefined' && window.location.protocol.startsWith('http')
}
