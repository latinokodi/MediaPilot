import { getElectronAPI, type ApiResult } from '../types/electron'

/**
 * Typed IPC wrapper for Electron main process.
 */
export async function api<T = unknown>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: any,
): Promise<T> {
  const ea = getElectronAPI()
  if (!ea) {
    throw new Error('electronAPI not found. Are you running in Electron?')
  }

  try {
    if (path.startsWith('/settings') && method === 'GET') return await ea.getSettings() as unknown as T
    if (path.startsWith('/settings') && method === 'POST') return await ea.setSettings(body as any) as unknown as T
    if (path.startsWith('/downloads/add-torrent-url')) return await ea.addTorrentUrl(body!.url as string, body!.service as string, body!.type as any) as unknown as T
    if (path.startsWith('/downloads/add')) return await ea.addMagnet(body!.magnet as string, body!.service as string, body!.type as any) as unknown as T
    if (path.startsWith('/downloads') && method === 'GET') return await ea.getDownloads() as unknown as T
    if (path === '/downloads/clear-completed' && method === 'POST') return await ea.clearCompleted() as unknown as T
    if (path.startsWith('/downloads/') && method === 'DELETE') {
      const id = path.split('/')[2]
      return await ea.controlTorrent(id, 'delete') as unknown as T
    }
    if (path.startsWith('/downloads/cancel/') && method === 'POST') {
      const id = path.split('/')[3]
      return await ea.cancelDownload(id) as unknown as T
    }
    if (path.startsWith('/search')) return await ea.searchMetaSearch((body as any)?.query) as unknown as T
    if (path.startsWith('/select-folder')) return { path: await ea.selectFolder() } as unknown as T

    if (path === '/auth/start') return await ea.authStart() as unknown as T
    if (path === '/auth/user') return await ea.getUserInfo() as unknown as T
    if (path.startsWith('/auth/poll/')) {
      const deviceCode = path.split('/')[3]
      return await ea.authPoll(deviceCode) as unknown as T
    }
    if (path === '/settings/test-metasearch') return await ea.testMetaSearch() as unknown as T

    if (path === '/plugins/check') return await ea.checkPlugins() as unknown as T
    if (path === '/plugins/update') return await ea.updatePlugins() as unknown as T

    if (path === '/rd/auth/start') return await ea.rdAuthStart() as unknown as T
    if (path.startsWith('/rd/auth/poll/')) {
      const deviceCode = path.split('/')[4]
      return await ea.rdAuthPoll(deviceCode) as unknown as T
    }
    if (path === '/rd/user') return await ea.rdUserInfo() as unknown as T
    if (path === '/rd/traffic') return await ea.rdTraffic() as unknown as T
    if (path === '/rd/select-files') return await ea.rdSelectFiles((body as any)?.torrentId) as unknown as T

    return { success: true } as unknown as T
  } catch (err: unknown) {
    throw new Error(err instanceof Error ? err.message : 'Request failed')
  }
}
