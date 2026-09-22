/**
 * plugin-updater.ts — Fetches and updates search plugins from the
 * qBittorrent community repository.
 *
 * Downloads .py plugin files from GitHub, compares versions, and
 * saves updated plugins to a user-writable directory.
 */

import https from 'https'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

// ── Config ─────────────────────────────────────────────

const GITHUB_API = 'https://api.github.com/repos/qbittorrent/search-plugins/contents/nova3/engines'
const PLUGIN_EXT = '.py'
const VERSION_RE = /#\s*VERSION\s*:\s*([\d.]+)/i

// ── Types ──────────────────────────────────────────────

export interface PluginInfo {
  name: string
  localVersion: string | null
  remoteVersion: string | null
  needsUpdate: boolean
}

export interface UpdateResult {
  plugins: PluginInfo[]
  updated: string[]
  errors: string[]
}

// ── Paths ──────────────────────────────────────────────

function getBundledEnginesDir(): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.join(__dirname, '..', 'electron', 'qbit-plugins', 'engines')
  }
  return path.join(process.resourcesPath || app.getAppPath(), 'qbit-plugins', 'engines')
}

function getUserPluginsDir(): string {
  const dir = path.join(app.getPath('userData'), 'plugins', 'engines')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── Helpers ────────────────────────────────────────────

function parseVersion(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    for (const line of lines.slice(0, 10)) {
      const m = line.match(VERSION_RE)
      if (m) return m[1]
    }
  } catch {}
  return null
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'TorDownloader-PRO/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        fetchJson(res.headers.location!).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'TorDownloader-PRO/1.0' },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        fetchText(res.headers.location!).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

// ── Public API ─────────────────────────────────────────

export async function checkPluginsForUpdates(): Promise<PluginInfo[]> {
  const bundledDir = getBundledEnginesDir()
  const userDir = getUserPluginsDir()

  // Get remote file list
  let remoteFiles: Array<{ name: string; download_url: string }> = []
  try {
    remoteFiles = await fetchJson(GITHUB_API)
  } catch (err: any) {
    console.error('[PluginUpdater] Failed to fetch plugin list:', err.message)
    throw new Error('Failed to fetch plugin list from GitHub')
  }

  const results: PluginInfo[] = []

  for (const rf of remoteFiles) {
    if (!rf.name.endsWith(PLUGIN_EXT)) continue

    // Check local version (user plugins take priority)
    const userPath = path.join(userDir, rf.name)
    const bundledPath = path.join(bundledDir, rf.name)
    const localPath = fs.existsSync(userPath) ? userPath : bundledPath
    const localVersion = parseVersion(localPath)

    // Fetch remote file to parse its version
    let remoteVersion: string | null = null
    try {
      const content = await fetchText(rf.download_url)
      for (const line of content.split('\n').slice(0, 10)) {
        const m = line.match(VERSION_RE)
        if (m) { remoteVersion = m[1]; break }
      }
    } catch {
      // Can't fetch this plugin — skip
      continue
    }

    const needsUpdate = localVersion !== null && remoteVersion !== null &&
      compareVersions(remoteVersion, localVersion) > 0

    results.push({
      name: rf.name.replace(PLUGIN_EXT, ''),
      localVersion,
      remoteVersion,
      needsUpdate,
    })
  }

  return results.sort((a, b) => a.name.localeCompare(b.name))
}

export async function updatePlugins(): Promise<UpdateResult> {
  const plugins = await checkPluginsForUpdates()
  const toUpdate = plugins.filter(p => p.needsUpdate)
  const userDir = getUserPluginsDir()
  const updated: string[] = []
  const errors: string[] = []

  if (toUpdate.length === 0) {
    return { plugins, updated, errors }
  }

  // Fetch full remote file list again to get download URLs
  let remoteFiles: Array<{ name: string; download_url: string }> = []
  try {
    remoteFiles = await fetchJson(GITHUB_API)
  } catch (err: any) {
    return { plugins, updated, errors: [err.message] }
  }

  const urlMap = new Map(remoteFiles.map(f => [f.name, f.download_url]))

  for (const plugin of toUpdate) {
    const filename = plugin.name + PLUGIN_EXT
    const url = urlMap.get(filename)
    if (!url) {
      errors.push(`${plugin.name}: not found in repository`)
      continue
    }

    try {
      console.log(`[PluginUpdater] Downloading ${filename}...`)
      const content = await fetchText(url)
      const destPath = path.join(userDir, filename)
      fs.writeFileSync(destPath, content, 'utf-8')
      console.log(`[PluginUpdater] Updated ${filename} → v${plugin.remoteVersion}`)
      updated.push(plugin.name)
    } catch (err: any) {
      errors.push(`${plugin.name}: ${err.message}`)
    }
  }

  return { plugins, updated, errors }
}

// ── Version comparison ─────────────────────────────────

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const va = partsA[i] || 0
    const vb = partsB[i] || 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}
