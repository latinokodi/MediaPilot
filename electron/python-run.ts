// python-run.ts — shared Python subprocess helpers for the automation
// engine (watchlist monitor + grabber). Mirrors the spawn pattern used by
// server.ts but without importing anything Electron-specific.
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import type { Settings } from './db'

const DEFAULT_JACKETT_INDEXERS = [
  '1337x', 'eztv', 'thepiratebay', 'yts', 'torrentgalaxyclone',
  'torrentdownloads', 'therarbg', 'subsplease',
  'dontorrent', 'divxtotal', 'wolfmax4k', 'catorrent', 'limetorrents',
  'extratorrent-st', 'torrentproject2', 'torrent9',
]

export function pythonPath(): string {
  return process.env.TDP_PYTHON || 'python3'
}

export function scriptPath(scriptName: string): string {
  return path.join(__dirname, '..', 'electron', scriptName)
}

/**
 * Populate the process env consumed by meta-search.py / latino-providers.py:
 * JACKETT_URL, JACKETT_API_KEY, JACKETT_INDEXERS, TMDB_API_KEY.
 * Precedence: explicit settings values > local Jackett ServerConfig.json
 * auto-discovery > whatever is already in the env. Never clears.
 */
export function setupSearchEnv(settings: Pick<Settings, 'tmdb_api_key' | 'jackett_url' | 'jackett_api_key'>): void {
  if (settings.jackett_url?.trim()) process.env.JACKETT_URL = settings.jackett_url.trim()
  else if (!process.env.JACKETT_URL) {
    const candidates = [
      // Búsqueda de un Jackett local: $JACKETT_CONFIG explícito, el layout
      // habitual de Linux/docker y, en Windows, %APPDATA%\Jackett.
      process.env.JACKETT_CONFIG || '',
      path.join(os.homedir(), 'appdata', 'jackett', 'Jackett', 'ServerConfig.json'),
      '/config/Jackett/ServerConfig.json',
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Jackett', 'ServerConfig.json') : '',
    ].filter(Boolean)
    for (const cfgPath of candidates) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        if (cfg.APIKey) {
          process.env.JACKETT_URL = process.env.JACKETT_URL || `http://127.0.0.1:${cfg.Port || 9117}`
          process.env.JACKETT_API_KEY = process.env.JACKETT_API_KEY || cfg.APIKey
          break
        }
      } catch { /* next candidate */ }
    }
  }
  if (settings.jackett_api_key?.trim()) process.env.JACKETT_API_KEY = settings.jackett_api_key.trim()
  if (!process.env.JACKETT_INDEXERS) process.env.JACKETT_INDEXERS = DEFAULT_JACKETT_INDEXERS.join(',')
  if (settings.tmdb_api_key?.trim()) process.env.TMDB_API_KEY = settings.tmdb_api_key.trim()
}

/**
 * Spawn a python script and resolve with its parsed JSON stdout (the whole
 * stdout is parsed; on failure/empty returns null). Kills on timeout.
 */
export function runPythonJson(
  scriptName: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<any> {
  return new Promise((resolve) => {
    const proc = spawn(pythonPath(), [scriptPath(scriptName), ...args], {
      env: { ...process.env as any, ...env },
      windowsHide: true,
    })
    const startedAt = Date.now()
    console.debug(`[py] > ${scriptName} ${args.join(' ')}`)
    let stdout = ''
    let stderr = ''
    let settled = false
    proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf-8')))
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf-8')))
    const timer = setTimeout(() => { if (!settled) { settled = true; try { proc.kill('SIGTERM') } catch { /* gone */ } resolve(null) } }, timeoutMs)
    proc.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.debug(`[py] < ${scriptName} (${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${stdout.length} bytes)`)
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : null)
      } catch {
        console.error(`[py] ${scriptName} bad JSON: ${(stdout || stderr).slice(0, 300)}`)
        resolve(null)
      }
    })
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.error(`[py] spawn ${scriptName} failed: ${err.message}`)
      resolve(null)
    })
  })
}

/**
 * Spawn a python script in --stream mode and resolve with every JSON line
 * parsed (non-JSON lines are skipped). Kills on timeout. Used by the grabber
 * to consume provider_results / engine_results events synchronously.
 */
export function runPythonLines(
  scriptName: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 75_000,
): Promise<any[]> {
  return new Promise((resolve) => {
    const proc = spawn(pythonPath(), [scriptPath(scriptName), ...args], {
      env: { ...process.env as any, ...env },
      windowsHide: true,
    })
    const startedAt = Date.now()
    console.debug(`[py] > ${scriptName} ${args.join(' ')}`)
    let buffer = ''
    const events: any[] = []
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; try { proc.kill('SIGTERM') } catch { /* gone */ } resolve(events) } }, timeoutMs)
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { events.push(JSON.parse(trimmed)) } catch { /* debug output */ }
      }
    })
    proc.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.debug(`[py] < ${scriptName} (${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${events.length} eventos)`)
      resolve(events)
    })
    proc.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(events)
    })
  })
}
