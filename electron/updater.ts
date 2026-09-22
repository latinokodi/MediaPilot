import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { BrowserWindow } from 'electron'
import { getSettings, updateSettings } from './db'

// ── Circuit breaker ─────────────────────────────────
let consecutiveFailures = 0
let cooldownUntil: number = 0
const MAX_FAILURES = 3
const COOLDOWN_MS = 6 * 3600 * 1000 // 6 hours
const PROMPT_COOLDOWN_MS = 24 * 3600 * 1000 // 24 hours (user dismissed)

let mainWindow: BrowserWindow | null = null
let updateInfo: UpdateInfo | null = null

export function initAutoUpdater(win: BrowserWindow): void {
  // Skip entirely in dev mode — no update logic
  if (process.env.VITE_DEV_SERVER_URL) return

  mainWindow = win

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false

  autoUpdater.on('update-available', (info) => {
    updateInfo = info
    consecutiveFailures = 0 // reset breaker on success
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info.version)
    }
  })

  autoUpdater.on('update-not-available', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-not-available')
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-progress', progress.percent)
    }
  })

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded')
    }
  })

  autoUpdater.on('error', (err) => {
    consecutiveFailures++
    if (consecutiveFailures >= MAX_FAILURES && !cooldownUntil) {
      cooldownUntil = Date.now() + COOLDOWN_MS
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', err.message || 'Unknown update error')
    }
  })
}

export function checkForUpdates(): void {
  // Dev mode — never check
  if (process.env.VITE_DEV_SERVER_URL) return

  // Circuit breaker: too many failures, wait for cooldown
  if (cooldownUntil && Date.now() < cooldownUntil) {
    return
  }

  // User dismissed prompt recently — skip automatic check,
  // but allow explicit manual check (caller handles this)
  const settings = getSettings()
  if (settings.last_update_prompt) {
    const lastPrompt = new Date(settings.last_update_prompt).getTime()
    if (Date.now() - lastPrompt < PROMPT_COOLDOWN_MS) {
      return // skip auto check; manual check bypasses this
    }
  }

  autoUpdater.checkForUpdates().catch(() => {
    // Network error — silent, app keeps working
    consecutiveFailures++
    if (consecutiveFailures >= MAX_FAILURES && !cooldownUntil) {
      cooldownUntil = Date.now() + COOLDOWN_MS
    }
  })
}

export function checkForUpdatesManual(): void {
  // Manual check — bypasses all cooldowns and circuit breaker
  if (process.env.VITE_DEV_SERVER_URL) return

  consecutiveFailures = 0
  cooldownUntil = 0

  autoUpdater.checkForUpdates().catch((err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', err.message || 'Check failed')
    }
  })
}

export function downloadUpdate(): void {
  autoUpdater.downloadUpdate().catch((err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        'update-error',
        `Download failed: ${err.message || 'Unknown error'}`
      )
    }
  })
}

export function installUpdate(): void {
  // applyUnzip=false for NSIS — it runs the installer, not a zip extraction
  autoUpdater.quitAndInstall(false, true)
}

export function dismissUpdate(): void {
  // Record cooldown so we don't nag again for 24h
  updateSettings({ last_update_prompt: new Date().toISOString() } as any)
  updateInfo = null
}

export function isUpdateDownloaded(): boolean {
  return autoUpdater.currentVersion?.downloadPromise != null
}
