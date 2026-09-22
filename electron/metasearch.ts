/**
 * metasearch.ts — Multi-engine torrent search for the headless web server.
 *
 * Spawns meta-search.py, which queries Jackett (Torznab API; if you run a
 * FlareSolverr instance, Jackett is the one using it) plus the latino sources
 * (resolved via TMDB), aggregates and deduplicates the results.
 */

import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import { app } from 'electron'

// ── Types ──────────────────────────────────────────────

export interface MetaResult {
  title: string
  size: string
  seeders: number
  peers: number
  link: string
  indexer: string
  info_hash: string | null
}

// ── Paths ──────────────────────────────────────────────

function isLinux(): boolean {
  return process.platform === 'linux'
}

function getDataDir(): string {
  if (process.env.TDP_DATA_DIR) return process.env.TDP_DATA_DIR
  if (typeof app !== 'undefined' && app && typeof app.getPath === 'function') {
    return app.getPath('userData')
  }
  return require('os').homedir() + '/.tordownloader-pro'
}

function getRunnerPath(): string {
  // In dev: use Python to run the .py script directly
  // In prod (packaged): use the bundled PyInstaller .exe (no Python needed)
  if (isLinux()) {
    // Headless Linux (web server): meta-search.py = Jackett Torznab +
    // latino providers (Cinecalidad/Comet/TCL). Always run the .py with
    // the configured python.
    return path.join(__dirname, '..', 'electron', 'meta-search.py')
  }
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.join(__dirname, '..', 'electron', 'meta-search.py')
  }
  return path.join(process.resourcesPath || app.getAppPath(), 'qbit-plugins', 'qbit-runner.exe')
}

function getRunnerCommand(): { cmd: string; args: string[] } {
  const runnerPath = getRunnerPath()
  if (runnerPath.endsWith('.py')) {
    const py = process.env.TDP_PYTHON || (isLinux() ? 'python3' : 'python')
    return { cmd: py, args: [runnerPath] }
  }
  return { cmd: runnerPath, args: [] }
}

function getUserPluginsDir(): string {
  return path.join(getDataDir(), 'plugins', 'engines')
}

// ── Auto-install cloudscraper ──────────────────────────

let _ensureDepsPromise: Promise<boolean> | null = null

function ensureDeps(): Promise<boolean> {
  if (_ensureDepsPromise) return _ensureDepsPromise

  // In production, the .exe bundles Python + cloudscraper — nothing to check
  if (!process.env.VITE_DEV_SERVER_URL && !isLinux()) {
    _ensureDepsPromise = Promise.resolve(true)
    return _ensureDepsPromise
  }

  _ensureDepsPromise = new Promise<boolean>((resolve) => {
    const py = process.env.TDP_PYTHON || (isLinux() ? 'python3' : 'python')
    const check = spawn(py, ['-c', 'import cloudscraper'], {
      windowsHide: true,
    })

    check.on('close', (code) => {
      if (code === 0) {
        resolve(true)
        return
      }

      // cloudscraper not installed — try pip install
      const install = spawn(py, ['-m', 'pip', 'install', '--quiet', 'cloudscraper'], {
        windowsHide: true,
      })

      install.on('close', (installCode) => {
        resolve(installCode === 0)
      })

      install.stderr.on('data', () => {
        // suppress pip output
      })
    })

    check.stderr.on('data', () => {
      // suppress
    })
  })

  return _ensureDepsPromise
}

// ── Runner ──────────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 90_000 // 90 seconds — enough for 17 engines through CF

export interface SearchProgress {
  type: 'engine_start' | 'engine_results' | 'done'
  engine?: string
  results?: MetaResult[]
  total?: number
}

export interface SearchStreamCallbacks {
  onProgress: (progress: SearchProgress) => void
  onDone: (results: MetaResult[]) => void
  onError: (error: Error) => void
}

export class MetaSearch {
  private runnerPath: string
  private ready: boolean = false

  constructor() {
    this.runnerPath = getRunnerPath()
  }

  async initialize(): Promise<void> {
    const ok = await ensureDeps()
    if (!ok) {
      console.warn('[MetaSearch] cloudscraper not available — some sites may fail')
    }
    this.ready = true
  }

  async search(query: string): Promise<MetaResult[]> {
    if (!this.ready) {
      await this.initialize()
    }

    console.log(`[MetaSearch] Starting batch search: "${query}"`)

    return new Promise<MetaResult[]>((resolve) => {
      let stdout = ''
      let stderr = ''
      let resolved = false

      const { cmd, args } = getRunnerCommand()
      const proc: ChildProcess = spawn(cmd, [...args, query], {
        windowsHide: true,
        timeout: SEARCH_TIMEOUT_MS,
        env: { ...process.env },
      })

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          proc.kill('SIGTERM')
          console.warn(`[MetaSearch] Search timed out after ${SEARCH_TIMEOUT_MS}ms for: "${query}"`)
          resolve([])
        }
      }, SEARCH_TIMEOUT_MS)

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (resolved) return
        resolved = true

        if (stderr && code !== 0) {
          console.warn(`[MetaSearch] stderr for "${query}":`, stderr.slice(0, 500))
        }

        if (!stdout.trim()) {
          resolve([])
          return
        }

        try {
          const results: MetaResult[] = JSON.parse(stdout)
          resolve(results)
        } catch (err) {
          console.error(`[MetaSearch] JSON parse failed for "${query}"`, (err as Error).message)
          resolve([])
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        if (resolved) return
        resolved = true
        console.error(`[MetaSearch] Failed to spawn Python runner:`, err.message)
        resolve([])
      })
    })
  }

  async searchStream(query: string, callbacks: SearchStreamCallbacks): Promise<void> {
    if (!this.ready) {
      await this.initialize()
    }

    return new Promise<void>((resolve) => {
      let buffer = ''
      let stderr = ''
      let resolved = false
      let finalResults: MetaResult[] = []

      const { cmd, args } = getRunnerCommand()
      const proc: ChildProcess = spawn(cmd, [...args, '--stream', query], {
        windowsHide: true,
        timeout: SEARCH_TIMEOUT_MS,
        env: { ...process.env },
      })

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          proc.kill('SIGTERM')
          console.warn(`[MetaSearch] Stream search timed out for: "${query}"`)
          callbacks.onError(new Error('Search timed out'))
          resolve()
        }
      }, SEARCH_TIMEOUT_MS)

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')

        // Process complete lines from the buffer
        const lines = buffer.split('\n')
        // Keep the last partial line in buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          try {
            const progress: SearchProgress = JSON.parse(trimmed)

            if (progress.type === 'engine_start' || progress.type === 'engine_results') {
              callbacks.onProgress(progress)
            } else if (progress.type === 'done') {
              // finalResults will be set via onProgress (engine_results accumulate)
              // The done event signals completion
            }
          } catch {
            // Non-JSON line (debug output), skip
          }
        }
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (resolved) return
        resolved = true

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const progress: SearchProgress = JSON.parse(buffer.trim())
            if (progress.type === 'engine_results' || progress.type === 'engine_start') {
              callbacks.onProgress(progress)
            }
          } catch { /* ignore */ }
        }

        if (stderr && code !== 0) {
          console.warn(`[MetaSearch] Stream stderr for "${query}":`, stderr.slice(0, 500))
        }

        // Pass empty results if nothing was collected
        callbacks.onDone([])
        resolve()
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        if (resolved) return
        resolved = true
        console.error(`[MetaSearch] Stream failed to spawn runner:`, err.message)
        callbacks.onError(err)
        resolve()
      })
    })
  }
}

// ── Singleton ──────────────────────────────────────────

let _instance: MetaSearch | null = null

export function getMetaSearch(): MetaSearch {
  if (!_instance) {
    _instance = new MetaSearch()
  }
  return _instance
}

export function initMetaSearch(): void {
  const ms = getMetaSearch()
  ms.initialize().catch((err) => {
    console.error('[MetaSearch] Initialization failed:', err)
  })
}
