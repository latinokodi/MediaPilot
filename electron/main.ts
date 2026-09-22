import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { spawn } from 'child_process'
import fs from 'fs'
import { initDB, getSettings, updateSettings, getDownloads, addDownload, updateDownload, deleteDownload, getDownloadByTorboxId, Settings } from './db'
import { initMetaSearch, getMetaSearch, type SearchProgress } from './metasearch'
import { checkPluginsForUpdates, updatePlugins } from './plugin-updater'
import { TorboxAPI } from './torbox'
import { RealDebridAPI, RD_OPENSOURCE_CLIENT_ID } from './realdebrid'
import { startWorker, cancelLocalDownload } from './worker'
import { initAutoUpdater, checkForUpdates, checkForUpdatesManual, downloadUpdate, installUpdate, dismissUpdate } from './updater'

// ── Single instance lock ──────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

let mainWindow: BrowserWindow | null = null

// ── Log collector ──────────────────────────────────────
const logBuffer: Array<{ ts: string; text: string; level: string }> = []
const LOG_MAX = 500

function sendLog(level: string, ...args: any[]) {
  const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  const entry = { ts: new Date().toISOString().slice(11, 19), text, level }
  logBuffer.push(entry)
  if (logBuffer.length > LOG_MAX) logBuffer.shift()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-log', entry)
  }
}

// Intercept console.* globally
const _origLog = console.log
const _origWarn = console.warn
const _origError = console.error
console.log = (...args: any[]) => { _origLog(...args); sendLog('info', ...args) }
console.warn = (...args: any[]) => { _origWarn(...args); sendLog('warn', ...args) }
console.error = (...args: any[]) => { _origError(...args); sendLog('error', ...args) }

// ── Global error handlers ───────────────────────────
process.on('uncaughtException', (err) => {
  _origError.call(console, '[FATAL] Uncaught exception:', err)
  sendLog('error', '[FATAL] Uncaught exception:', err.message || err)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-log', { ts: new Date().toISOString().slice(11, 19), text: `Fatal error: ${err.message}`, level: 'error' })
  }
})

process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason)
  _origError.call(console, '[FATAL] Unhandled rejection:', reason)
  sendLog('error', '[FATAL] Unhandled rejection:', msg)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-log', { ts: new Date().toISOString().slice(11, 19), text: `Unhandled rejection: ${msg}`, level: 'error' })
  }
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'TORDOWNLOADER',
    backgroundColor: '#0a0a0a',
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(async () => {
  try {
    initDB()
  } catch (err: any) {
    console.error('[App] Database init failed:', err.message)
    // Retry after a delay (DB might be locked by another instance)
    setTimeout(() => {
      try { initDB() } catch (e: any) { console.error('[App] DB retry also failed:', e.message) }
    }, 2000)
  }
  initMetaSearch()  // starts Python runner dependency check
  createWindow()

  // Init auto-updater after window exists for IPC
  initAutoUpdater(mainWindow!)
  // Defer update check — let the window render first so IPC listeners are registered
  setTimeout(() => checkForUpdates(), 3000)

  // Start the background worker for Torbox & local downloads
  startWorker(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

// ─── IPC Handlers ───────────────────────────

ipcMain.handle('get-settings', () => getSettings())

ipcMain.handle('set-settings', (_e, settings: Partial<Settings>) => {
  updateSettings(settings)
  return { success: true }
})

ipcMain.handle('search-metasearch', async (e, query: string) => {
  try {
    const ms = getMetaSearch()
    const sender = e.sender
    let allResults: import('./metasearch').MetaResult[] = []

    await ms.searchStream(query, {
      onProgress: (progress: SearchProgress) => {
        if (sender.isDestroyed()) return
        sender.send('search-progress', { tabId: null, ...progress })
      },
      onDone: (results) => {
        allResults = results
      },
      onError: (err) => {
        if (!sender.isDestroyed()) {
          sender.send('search-error', err.message)
        }
      },
    })

    return { success: true, data: allResults }
  } catch (error: any) {
    return { success: false, error: error.message || 'Search failed' }
  }
})

ipcMain.handle('get-downloads', () => getDownloads());

ipcMain.handle('add-magnet', async (_e, magnet: string, service: string = 'torbox') => {
  const settings = getSettings();

  if (service === 'realdebrid') {
    if (!settings.realdebrid_token) {
      return { success: false, error: 'Real-Debrid token is not configured' };
    }
    try {
      const rd = new RealDebridAPI(settings.realdebrid_token);
      const result = await rd.addMagnet(magnet);

      if (result.success && result.data) {
        const { id } = RealDebridAPI.torrentIdentity(result.data);
        if (id) {
          const existing = getDownloadByTorboxId(id);
          if (existing) {
            updateDownload(id, { local_status: 'pending', service: 'realdebrid' });
          } else {
            addDownload({
              torbox_id: id,
              name: result.data.filename || result.data.name || 'Pending...',
              status: 'waiting_files_selection',
              progress: 0,
              service: 'realdebrid',
            });
          }
          if (mainWindow) mainWindow.webContents.send('downloads-updated');
        }
      }
      return result;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // TorBox
  if (!settings.torbox_token) {
    return { success: false, error: 'TorBox token is not configured' };
  }

  try {
    const tb = new TorboxAPI(settings.torbox_token);
    const result = await tb.addMagnet(magnet);

    if (result.success && result.data) {
      const { id } = TorboxAPI.torrentIdentity(result.data);
      if (id) {
        const existing = getDownloadByTorboxId(id);
        if (existing) {
          updateDownload(id, { local_status: 'pending', service: 'torbox' });
        } else {
          addDownload({
            torbox_id: id,
            name: result.data.name || 'Pending...',
            status: 'pending',
            progress: 0,
            service: 'torbox',
          });
        }
        if (mainWindow) mainWindow.webContents.send('downloads-updated');
      }
    }
    return result;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('add-torrent-url', async (_e, torrentUrl: string, service: string = 'torbox') => {
  const settings = getSettings();

  if (service === 'realdebrid') {
    if (!settings.realdebrid_token) {
      return { success: false, error: 'Real-Debrid token is not configured' };
    }
    try {
      const rd = new RealDebridAPI(settings.realdebrid_token);
      const result = await rd.addTorrentFromUrl(torrentUrl);

      if (result.success && result.data) {
        const { id } = RealDebridAPI.torrentIdentity(result.data);
        if (id) {
          const existing = getDownloadByTorboxId(id);
          if (existing) {
            updateDownload(id, { local_status: 'pending', service: 'realdebrid' });
          } else {
            addDownload({
              torbox_id: id,
              name: result.data.filename || result.data.name || 'Pending...',
              status: 'waiting_files_selection',
              progress: 0,
              service: 'realdebrid',
            });
          }
          if (mainWindow) mainWindow.webContents.send('downloads-updated');
        }
      }
      return result;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // TorBox
  if (!settings.torbox_token) {
    return { success: false, error: 'TorBox token is not configured' };
  }

  try {
    const tb = new TorboxAPI(settings.torbox_token);
    const result = await tb.addTorrentFromUrl(torrentUrl);

    if (result.success && result.data) {
      const { id } = TorboxAPI.torrentIdentity(result.data);
      if (id) {
        const existing = getDownloadByTorboxId(id);
        if (existing) {
          updateDownload(id, { local_status: 'pending', service: 'torbox' });
        } else {
          addDownload({
            torbox_id: id,
            name: result.data.name || 'Pending...',
            status: 'pending',
            progress: 0,
            service: 'torbox',
          });
        }
        if (mainWindow) mainWindow.webContents.send('downloads-updated');
      }
    }
    return result;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('control-torrent', async (_e, torrentId: string, operation: string) => {
  const settings = getSettings();
  if (!settings.torbox_token) {
    return { success: false, error: 'TorBox token is not configured' };
  }
  
  try {
    const tb = new TorboxAPI(settings.torbox_token);
    const result = await tb.controlTorrent(torrentId, operation);
    
    if (operation.toLowerCase() === 'delete') {
      deleteDownload(torrentId);
      if (mainWindow) mainWindow.webContents.send('downloads-updated');
    }
    return result;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cancel-download', async (_e, torrentId: string) => {
  const settings = getSettings();
  const download = getDownloadByTorboxId(torrentId);

  // 1) Abort any running local download
  cancelLocalDownload(torrentId);

  // 2) Delete from the appropriate service
  if (download?.service === 'realdebrid' && settings.realdebrid_token) {
    try {
      const rd = new RealDebridAPI(settings.realdebrid_token);
      await rd.deleteTorrent(torrentId);
    } catch (err) {
      console.warn(`RD delete for ${torrentId} failed:`, err);
    }
  } else if (settings.torbox_token) {
    try {
      const tb = new TorboxAPI(settings.torbox_token);
      await tb.controlTorrent(torrentId, 'Delete');
    } catch (err) {
      console.warn(`TorBox delete for ${torrentId} failed:`, err);
    }
  }

  // 3) Remove from local DB
  deleteDownload(torrentId);
  if (mainWindow) mainWindow.webContents.send('downloads-updated');

  return { success: true };
});

ipcMain.handle('clear-completed', async () => {
  const settings = getSettings();
  const downloads = getDownloads();
  const completed = downloads.filter(d =>
    (d.status || '').toLowerCase() === 'completed' || 
    (d.status || '').toLowerCase() === 'downloaded' ||
    (d.status || '').toLowerCase() === 'cached' ||
    (d.status || '').toLowerCase() === 'finished'
  ).filter(d =>
    (d.local_status || '').toLowerCase() === 'completed'
  );

  for (const d of completed) {
    if (d.service === 'realdebrid' && settings.realdebrid_token) {
      try {
        const rd = new RealDebridAPI(settings.realdebrid_token);
        await rd.deleteTorrent(d.torbox_id);
      } catch(e) {}
    } else if (settings.torbox_token) {
      try {
        const tb = new TorboxAPI(settings.torbox_token);
        await tb.controlTorrent(d.torbox_id, 'Delete');
      } catch(e) {}
    }
    deleteDownload(d.torbox_id);
  }
  if (mainWindow) mainWindow.webContents.send('downloads-updated');
  return { success: true };
});

ipcMain.handle('auth-start', async () => {
  try {
    const tb = new TorboxAPI();
    return await tb.getDeviceCode();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('auth-poll', async (_e, deviceCode: string) => {
  try {
    const tb = new TorboxAPI();
    const res = await tb.getToken(deviceCode);
    if (res.success && res.data) {
      let token = res.data;
      if (typeof token === 'object') {
        token = token.access_token || token.token;
      }
      if (token) {
        updateSettings({ torbox_token: token });
      }
    }
    return res;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('torbox-user-info', async () => {
  const settings = getSettings();
  if (!settings.torbox_token) return { success: false, error: 'No token' };
  try {
    const tb = new TorboxAPI(settings.torbox_token);
    return await tb.getUserInfo();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// ── Real-Debrid IPC ──────────────────────────

ipcMain.handle('rd-auth-start', async () => {
  try {
    const res = await RealDebridAPI.getDeviceCode();
    return res;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rd-auth-poll', async (_e, deviceCode: string) => {
  try {
    // Step 1: Get per-user credentials (client_id + client_secret)
    const credRes = await RealDebridAPI.getCredentials(RD_OPENSOURCE_CLIENT_ID, deviceCode);
    if (!credRes.success) {
      // pending → not authorized yet
      return credRes;
    }

    const { client_id, client_secret } = credRes.data;
    if (!client_id || !client_secret) {
      return { success: false, error: 'Invalid credentials response' };
    }

    // Step 2: Exchange for access_token + refresh_token
    const tokenRes = await RealDebridAPI.getToken(client_id, client_secret, deviceCode);
    if (!tokenRes.success || !tokenRes.data) {
      return { success: false, error: tokenRes.error || 'Failed to get token' };
    }

    const { access_token, refresh_token } = tokenRes.data;
    if (!access_token) {
      return { success: false, error: 'No access token in response' };
    }

    // Save everything
    updateSettings({
      realdebrid_token: access_token,
      realdebrid_refresh_token: refresh_token || '',
      realdebrid_client_id: client_id,
      realdebrid_client_secret: client_secret,
    });

    return { success: true, data: { access_token } };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rd-user-info', async () => {
  const settings = getSettings();
  if (!settings.realdebrid_token) return { success: false, error: 'No token' };
  try {
    const rd = new RealDebridAPI(settings.realdebrid_token);
    return await rd.getUserInfo();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rd-traffic', async () => {
  const settings = getSettings();
  if (!settings.realdebrid_token) return { success: false, error: 'No token' };
  try {
    const rd = new RealDebridAPI(settings.realdebrid_token);
    return await rd.getTraffic();
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rd-select-files', async (_e, torrentId: string) => {
  const settings = getSettings();
  if (!settings.realdebrid_token) return { success: false, error: 'No token' };
  try {
    const rd = new RealDebridAPI(settings.realdebrid_token);

    const infoRes = await rd.getTorrentInfo(torrentId);
    if (!infoRes.success || !infoRes.data) {
      return { success: false, error: 'Failed to get torrent info' };
    }

    const files = infoRes.data.files || [];
    if (files.length === 0) {
      return { success: false, error: 'No files in torrent' };
    }

    const fileIds = files.map((f: any) => String(f.id));
    const selectRes = await rd.selectFiles(torrentId, fileIds);

    if (selectRes.success) {
      updateDownload(torrentId, { status: 'downloading' });
      if (mainWindow) mainWindow.webContents.send('downloads-updated');
    }

    return selectRes;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-metasearch', async (_e, _data: { url: string; api_key: string }) => {
  try {
    const ms = getMetaSearch()
    // Run a quick search to verify Python runner and plugins work
    const results = await ms.search('ubuntu')
    return { success: true, detail: `MetaSearch ready — ${results.length} results from built-in plugins` }
  } catch (error: any) {
    return { success: false, error: error.message, detail: error.message }
  }
})

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('get-logs', () => {
  return [...logBuffer]
})

ipcMain.handle('get-app-version', () => {
  return app.getVersion()
})

ipcMain.handle('open-folder', async (_e, folderPath: string) => {
  const result = await shell.openPath(folderPath)
  return { success: !result, error: result || null }
})

ipcMain.handle('check-plugins', async () => {
  try {
    const plugins = await checkPluginsForUpdates()
    return { success: true, data: plugins }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('update-plugins', async () => {
  try {
    const result = await updatePlugins()
    return { success: true, data: result }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// ── TMDB Discover IPC ─────────────────────────

function getRunnerPath(scriptName: string): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.join(__dirname, '..', 'electron', scriptName)
  }
  return path.join(process.resourcesPath || app.getAppPath(), scriptName)
}

function spawnPython(scriptName: string, args: string[]): { cmd: string; allArgs: string[] } {
  const scriptPath = getRunnerPath(scriptName)
  if (scriptPath.endsWith('.py')) {
    // In production, prefer the bundled .exe over system Python
    if (!process.env.VITE_DEV_SERVER_URL) {
      const exePath = scriptPath.replace(/\.py$/, '.exe')
      if (fs.existsSync(exePath)) {
        return { cmd: exePath, allArgs: args }
      }
    }
    return { cmd: 'python', allArgs: [scriptPath, ...args] }
  }
  return { cmd: scriptPath, allArgs: args }
}

ipcMain.handle('tmdb-lists', async () => {
  const settings = getSettings()
  if (!settings.tmdb_api_key) {
    return { success: false, error: 'TMDB API key not configured' }
  }

  return new Promise((resolve) => {
    const { cmd, allArgs } = spawnPython('tmdb-provider.py', ['lists'])
    const label = 'tmdb-lists'
    console.log(`[TMDB] ${label}: spawning ${cmd} ${allArgs.join(' ')}`)
    const proc = spawn(cmd, allArgs, {
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, TMDB_API_KEY: settings.tmdb_api_key },
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
    proc.on('close', (code) => {
      if (stderr) console.warn(`[TMDB] ${label} stderr (exit ${code}):`, stderr.slice(0, 500))
      try {
        const data = JSON.parse(stdout)
        if (data.error) {
          console.error(`[TMDB] ${label} error:`, data.error)
          resolve({ success: false, error: data.error })
        } else {
          const count = data.movies ? Object.values(data.movies).reduce((a: number, v: any) => a + v.length, 0) : 0
          const tvCount = data.tv ? Object.values(data.tv).reduce((a: number, v: any) => a + v.length, 0) : 0
          console.log(`[TMDB] ${label}: ${count} movies + ${tvCount} tv shows`)
          resolve({ success: true, data })
        }
      } catch {
        const preview = stdout.slice(0, 500) || stderr.slice(0, 500) || '(empty)'
        console.error(`[TMDB] ${label} parse FAILED. stdout:`, preview)
        resolve({ success: false, error: `Failed to parse TMDB response: ${preview}` })
      }
    })
    proc.on('error', (err) => {
      console.error(`[TMDB] ${label} spawn failed:`, err.message)
      resolve({ success: false, error: err.message })
    })
  })
})

ipcMain.handle('tmdb-detail', async (_e, tmdbId: number, mediaType: string) => {
  const settings = getSettings()
  if (!settings.tmdb_api_key) {
    return { success: false, error: 'TMDB API key not configured' }
  }

  return new Promise((resolve) => {
    const { cmd, allArgs } = spawnPython('tmdb-provider.py', ['detail', String(tmdbId), mediaType])
    const label = `tmdb-detail(${mediaType}/${tmdbId})`
    console.log(`[TMDB] ${label}: spawning`)
    const proc = spawn(cmd, allArgs, {
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, TMDB_API_KEY: settings.tmdb_api_key },
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
    proc.on('close', (code) => {
      if (stderr) console.warn(`[TMDB] ${label} stderr (exit ${code}):`, stderr.slice(0, 500))
      try {
        const data = JSON.parse(stdout)
        if (data.error) {
          console.error(`[TMDB] ${label} error:`, data.error)
          resolve({ success: false, error: data.error })
        } else {
          console.log(`[TMDB] ${label}: OK (${data.title || '?'}, imdb=${data.imdb_id || '?'})`)
          resolve({ success: true, data })
        }
      } catch {
        const preview = stdout.slice(0, 500) || stderr.slice(0, 500) || '(empty)'
        console.error(`[TMDB] ${label} parse FAILED. stdout:`, preview)
        resolve({ success: false, error: `Failed to parse TMDB response: ${preview}` })
      }
    })
    proc.on('error', (err) => {
      console.error(`[TMDB] ${label} spawn failed:`, err.message)
      resolve({ success: false, error: err.message })
    })
  })
})

ipcMain.handle('tmdb-season', async (_e, tmdbId: number, seasonNumber: number) => {
  const settings = getSettings()
  if (!settings.tmdb_api_key) {
    return { success: false, error: 'TMDB API key not configured' }
  }

  return new Promise((resolve) => {
    const { cmd, allArgs } = spawnPython('tmdb-provider.py', ['season', String(tmdbId), String(seasonNumber)])
    const label = `tmdb-season(${tmdbId}/S${seasonNumber})`
    console.log(`[TMDB] ${label}: spawning`)
    const proc = spawn(cmd, allArgs, {
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, TMDB_API_KEY: settings.tmdb_api_key },
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
    proc.on('close', (code) => {
      if (stderr) console.warn(`[TMDB] ${label} stderr (exit ${code}):`, stderr.slice(0, 500))
      try {
        const data = JSON.parse(stdout)
        if (data.error) {
          console.error(`[TMDB] ${label} error:`, data.error)
          resolve({ success: false, error: data.error })
        } else {
          const epCount = data.episodes?.length || 0
          console.log(`[TMDB] ${label}: ${epCount} episodes`)
          resolve({ success: true, data })
        }
      } catch {
        const preview = stdout.slice(0, 500) || stderr.slice(0, 500) || '(empty)'
        console.error(`[TMDB] ${label} parse FAILED. stdout:`, preview)
        resolve({ success: false, error: `Failed to parse TMDB response: ${preview}` })
      }
    })
    proc.on('error', (err) => {
      console.error(`[TMDB] ${label} spawn failed:`, err.message)
      resolve({ success: false, error: err.message })
    })
  })
})

ipcMain.handle('tmdb-search', async (_e, query: string) => {
  const settings = getSettings()
  if (!settings.tmdb_api_key) {
    return { success: false, error: 'TMDB API key not configured' }
  }

  return new Promise((resolve) => {
    const { cmd, allArgs } = spawnPython('tmdb-provider.py', ['search', query])
    const label = `tmdb-search("${query}")`
    console.log(`[TMDB] ${label}: spawning`)
    const proc = spawn(cmd, allArgs, {
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, TMDB_API_KEY: settings.tmdb_api_key },
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
    proc.on('close', (code) => {
      if (stderr) console.warn(`[TMDB] ${label} stderr (exit ${code}):`, stderr.slice(0, 500))
      try {
        const data = JSON.parse(stdout)
        if (data.error) {
          console.error(`[TMDB] ${label} error:`, data.error)
          resolve({ success: false, error: data.error })
        } else {
          console.log(`[TMDB] ${label}: ${Array.isArray(data) ? data.length : 0} results`)
          resolve({ success: true, data })
        }
      } catch {
        const preview = stdout.slice(0, 500) || stderr.slice(0, 500) || '(empty)'
        console.error(`[TMDB] ${label} parse FAILED. stdout:`, preview)
        resolve({ success: false, error: `Failed to parse TMDB response: ${preview}` })
      }
    })
    proc.on('error', (err) => {
      console.error(`[TMDB] ${label} spawn failed:`, err.message)
      resolve({ success: false, error: err.message })
    })
  })
})

ipcMain.handle('tmdb-validate', async (_e, apiKey: string) => {
  return new Promise((resolve) => {
    const https = require('https')
    const url = `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`
    https.get(url, { headers: { 'User-Agent': 'TorDownloader-PRO/1.0' } }, (res: any) => {
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data.images) {
            updateSettings({ tmdb_api_key: apiKey })
            resolve({ success: true })
          } else if (data.status_code === 7) {
            resolve({ success: false, error: 'Invalid API key' })
          } else {
            resolve({ success: false, error: data.status_message || 'Validation failed' })
          }
        } catch {
          resolve({ success: false, error: 'Failed to validate' })
        }
      })
    }).on('error', (err: Error) => resolve({ success: false, error: err.message }))
    setTimeout(() => resolve({ success: false, error: 'Validation timed out' }), 10000)
  })
})

ipcMain.handle('latino-search', async (e, imdbId: string, mediaType: string, season?: string, episode?: string) => {
  const sender = e.sender
  const args = ['--stream', imdbId, mediaType]
  if (season) args.push(season)
  if (episode) args.push(episode)

  return new Promise<void>((resolve) => {
    const { cmd, allArgs } = spawnPython('latino-providers.py', args)
    const proc = spawn(cmd, allArgs, {
      windowsHide: true,
      timeout: 45_000,
      env: { ...process.env },
    })

    let buffer = ''
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      resolve()
    }, 45_000)

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const progress = JSON.parse(trimmed)
          if (!sender.isDestroyed()) {
            sender.send('latino-search-progress', progress)
          }
        } catch { /* skip */ }
      }
    })

    proc.on('close', () => {
      clearTimeout(timer)
      resolve()
    })

    proc.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
})

// ── Stremio Catalog Addon ──────────────────────

const CATALOG_BASE = 'https://btttr.cc/pVjfb-M2DP5XBD9sDwsBu-l1Sd6a9O464HotkvSKwzAMjM0kWmXJk-TkckX_90GOHdtRfrTYm0N9H8mQFEnoJYjRolALEwz-DARaMhbSoFN9mqATWJXgphBuv2oZBp0gVimXi-K4_DT1pwNYTTKpILsfDpSpLBeoi4Pqe6s8K6D4bCHLZ4N_cmO5BOBpMgOrMtBoKYFUrTiZFjJR8scGIEW9IgExl5Si5THkkq9IG3qLWrsCs1TrtuIZyblG-SwcYVYEictknsfPbVyMmUUuJWYoUoAoDCNYaCrjWjgMag4oBFietv0xWWR5ySmhG5VDmrs8EMGM5kpTIUt4myq4WV6GPdh51Tr9G8kFAraetHTjBpa4IpC0Ig1LQp2Amh_WbXVOEGueEiQqzlOSFvUGDGmnbs5F2uJZskvUXEmA5EgGjJI8XqPWXGkAY1HDGrWBGKWSRYAEl3QiEWgoASUBt84Zq_RmLx8yVnLOdQpglrmFPAOUCazRxssWUlOickSUBKCVEEWRWiUJjEtJncWqPk7kkYToqlwmVcR3xe3V1ZwnrlBnAHhx2TpZcIHJAsDkM01Jwl0NCIotV7Ktwi5dXTwDYIwJpRvANerEbKs047HNNcGaS0naHKz_UlL6eLD8XckYi1kGsFRaKx10gjSZCe5M5LPBRdS_3BdddK_2RN2wd-GJ-l0fdYDY80V9X1foi_b96ob9D77IsxiFv3uiKNoXda889VHkO9HzdYUHLHr_MQr3Xb24inrBX50gJYvB4OXNTXLwEkhMKRgEf9zdDAdsqjI2dgB2t-uiwSCYBa_vaqe12rvr8bePX9iowrDHxoX3NZ_rvcf9nX5jk6o-fb2n-nStc0jGsrtmA_c1vbeT19odlH0uoWV8mZqzayHYtGwWvr13dv89c6WV7ypnd7mxbELEhgWjkN3wI1b9wdFIaWOW-Mz3D5VacxGcls-4Ybe4IvbVUdito7D7-Rmf3zCQaptTnRMbOTC7qcFsUoDZL-xTOb98e0cGWa36ZnSm2t8452qNE4uaPaE2bOQgrDkKzxX9wZnYqH13zpRkyKbjx49sMr0ffz92BU4Nz4a3y9yyx6zDrmXCnqrJ6uv7fyO2tjfectnEcX81LArD-r5V_eEtN-70nN6v14ft6an20x7ntYLr7XD3CSenfCPC1TGbtJaAA8X6nm2g4eAWza4LNANWtMiHLZ491dvD8VZ-ZI1o3kB8toNdGE83cn_jqBXdVivIjuftIjX4S7ssSpbxWG5dafiqskbntktia6KqE6b75GKxqclfyc4F_3HaYLH5-JzWOD5kqOnl7fD-nJFer5nlFH8qyR6KLniO2G8aykV-9u-EzZbIjaTNb2c5l8e8OxeH_ocD1s6Srvb_0xmG2wJrxkillGyOg6OoWUFLzYUgfRTudsfGDY85fOIndIfHLsChIml6PRyOzqTBLaPNVuDay4mQNCtq5JJ1AtvKksa0eBA4hC0W20P3rya8ulcCY6loBe6NYBBgbpV7PNBqocmYYOBGXvnKMEX3qLEV_Juj4HazFc1RGOoErj19JqmpAjnBGC2Xi0qCC6oEFUlp543SfMEliuD19T8'

function catalogFetch(path: string): Promise<any> {
  return new Promise((resolve) => {
    const https = require('https')
    https.get(`${CATALOG_BASE}${path}`, { headers: { 'User-Agent': 'TorDownloader-PRO/1.0' } }, (res: any) => {
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) }
        catch { resolve(null) }
      })
    }).on('error', () => resolve(null))
    setTimeout(() => resolve(null), 15000)
  })
}

let _catalogManifest: any = null

ipcMain.handle('catalog-manifest', async () => {
  if (_catalogManifest) return { success: true, data: _catalogManifest }
  const manifest = await catalogFetch('/manifest.json')
  if (manifest) {
    _catalogManifest = manifest.catalogs || []
    return { success: true, data: _catalogManifest }
  }
  return { success: false, error: 'Failed to fetch catalog manifest' }
})

ipcMain.handle('catalog-items', async (_e, type: string, id: string) => {
  const data = await catalogFetch(`/catalog/${type}/${id}.json`)
  if (data && data.metas) {
    return { success: true, data: data.metas }
  }
  return { success: false, error: 'Failed to fetch catalog items' }
})

ipcMain.handle('catalog-meta', async (_e, type: string, imdbId: string) => {
  const data = await catalogFetch(`/meta/${type}/${imdbId}.json`)
  if (data && data.meta) {
    return { success: true, data: data.meta }
  }
  return { success: false, error: 'Failed to fetch meta' }
})

// ── Auto-update ──
ipcMain.handle('check-for-updates', () => {
  checkForUpdatesManual()
  return { success: true }
})
ipcMain.handle('download-update', () => {
  downloadUpdate()
  return { success: true }
})
ipcMain.handle('install-update', () => {
  installUpdate()
  return { success: true }
})
ipcMain.handle('dismiss-update', () => {
  dismissUpdate()
  return { success: true }
})
