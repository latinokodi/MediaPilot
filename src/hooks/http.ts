/**
 * Minimal HTTP helper for web-mode and desktop features. In desktop Electron
 * (running from file://), requests are routed to the local embedded server on 127.0.0.1:9650.
 */
export function isWebMode(): boolean {
  return typeof window !== 'undefined' && window.location.protocol.startsWith('http')
}

export function apiBase(): string {
  if (isWebMode()) return ''
  return 'http://127.0.0.1:9650'
}

export async function http<T = any>(path: string, method = 'GET', body?: any): Promise<T> {
  const url = path.startsWith('http') ? path : `${apiBase()}${path}`
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return (await res.json().catch(() => ({}))) as T
}

