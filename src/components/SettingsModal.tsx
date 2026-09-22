import { useState, useEffect, useRef } from 'react'
import { api } from '../hooks/useApi'
import { useT } from '../i18n'

interface SettingsSchema {
  torbox_token: string
  realdebrid_token: string
  realdebrid_refresh_token: string
  realdebrid_client_id: string
  realdebrid_client_secret: string
  destination_folder: string
  movies_folder: string
  series_folder: string
  auto_remove_completed: boolean
  tmdb_api_key: string
  language_profile?: string
  monitor_enabled?: boolean
  monitor_interval_minutes?: number
  max_concurrent_downloads?: number
  automation_service?: string
  automation_failover?: boolean
  max_movie_size_gb?: number
  max_series_size_gb?: number
  jellyfin_url?: string
  jellyfin_api_key?: string
}

interface Props {
  onClose: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
}

function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return email
  const [local, domain] = email.split('@')
  return local.slice(0, 3) + '\u2022\u2022\u2022' + '@' + domain
}

export function SettingsModal({ onClose, showToast }: Props) {
  const t = useT()
  const [settings, setSettings] = useState<SettingsSchema | null>(null)
  const [loading, setLoading] = useState(true)
  const [testingMetaSearch, setTestingMetaSearch] = useState(false)
  const [searchStatus, setSearchStatus] = useState<string | null>(null)
  const [authData, setAuthData] = useState<any | null>(null)
  const [torboxUser, setTorboxUser] = useState<any | null>(null)
  const [checkingPlugins, setCheckingPlugins] = useState(false)
  const [pluginStatus, setPluginStatus] = useState<string | null>(null)
  const [rdAuthData, setRdAuthData] = useState<any | null>(null)
  const [rdUser, setRdUser] = useState<any | null>(null)
  const [tmdbValidating, setTmdbValidating] = useState(false)
  const [tmdbStatus, setTmdbStatus] = useState<string | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)
  const rdPollTimer = useRef<number | null>(null)

  const fetchTorboxUser = async () => {
    try {
      const res = await api<any>('/auth/user')
      if (res.success && res.data) {
        setTorboxUser(res.data)
      }
    } catch (e) {
      // ignore
    }
  }

  const fetchRdUser = async () => {
    try {
      const res = await api<any>('/rd/user')
      if (res.success && res.data) {
        setRdUser(res.data)
      }
    } catch (e) {
      // ignore
    }
  }

  const startRdAuth = async () => {
    try {
      const res = await api<any>('/rd/auth/start')
      if (res.success && res.data) {
        setRdAuthData(res.data)
        // Poll every 5 seconds
        rdPollTimer.current = window.setInterval(async () => {
          const pollRes = await api<any>(`/rd/auth/poll/${res.data.device_code}`)
          if (pollRes.success) {
            if (rdPollTimer.current) window.clearInterval(rdPollTimer.current)
            setRdAuthData(null)
            showToast(t.settings.realdebridLinked, 'success')
            const updated = await api<SettingsSchema>('/settings')
            setSettings(updated)
            if (updated.realdebrid_token) {
              await fetchRdUser()
            }
          }
        }, 5000)
      } else {
        showToast(res.error || 'Failed to start auth', 'error')
      }
    } catch (e: any) {
      showToast(e.message || 'Auth failed', 'error')
    }
  }

  useEffect(() => {
    api<SettingsSchema>('/settings')
      .then(async (s) => {
        setSettings(s)
        if (s.torbox_token) {
          await fetchTorboxUser()
        }
        if (s.realdebrid_token) {
          await fetchRdUser()
        }
      })
      .catch((e) => showToast(e.message, 'error'))
      .finally(() => setLoading(false))

    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
      if (rdPollTimer.current) window.clearInterval(rdPollTimer.current)
    }
  }, [])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!settings) return
    try {
      await api('/settings', 'POST', settings)
      showToast(t.settings.settingsSaved, 'success')
      onClose()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t.settings.saveFailed, 'error')
    }
  }

  const handleTestMetaSearch = async () => {
    setTestingMetaSearch(true)
    try {
      const res = await api<any>('/settings/test-metasearch', 'POST')
      if (res.success) {
        setSearchStatus(res.detail || 'OK')
        showToast(res.detail || t.settings.enginesReady, 'success')
      } else {
        showToast(res.detail || t.settings.enginesFailed, 'error')
      }
    } catch (err: any) {
      showToast(err.message || t.settings.enginesFailed, 'error')
    } finally {
      setTestingMetaSearch(false)
    }
  }

  const handleUpdatePlugins = async () => {
    setCheckingPlugins(true)
    setPluginStatus(null)
    try {
      const res = await api<any>('/plugins/update')
      if (res.success && res.data) {
        const data = res.data
        if (data.updated.length > 0) {
          const msg = t.settings.pluginsUpdated.replace('{count}', String(data.updated.length))
          setPluginStatus(msg)
          showToast(msg, 'success')
        } else {
          setPluginStatus(t.settings.pluginsUpToDate)
          showToast(t.settings.pluginsUpToDate, 'success')
        }
      } else {
        setPluginStatus(res.error || t.settings.pluginsCheckFailed)
        showToast(res.error || t.settings.pluginsCheckFailed, 'error')
      }
    } catch (err: any) {
      setPluginStatus(err.message || t.settings.pluginsCheckFailed)
      showToast(err.message || t.settings.pluginsCheckFailed, 'error')
    } finally {
      setCheckingPlugins(false)
    }
  }

  const handleSelectFolder = async () => {
    try {
      const res = await api<{ path: string; error?: string }>('/select-folder')
      if (res.error) showToast(res.error, 'error')
      else if (res.path) setSettings((s) => s ? { ...s, destination_folder: res.path } : null)
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : t.settings.folderError, 'error')
    }
  }

  const handleValidateTmdb = async () => {
    if (!settings?.tmdb_api_key) return
    setTmdbValidating(true)
    setTmdbStatus(null)
    try {
      const electronAPI = (window as any).electronAPI
      const res = await electronAPI.tmdbValidate(settings.tmdb_api_key)
      if (res.success) {
        setTmdbStatus('Valid key')
        showToast('TMDB API key validada', 'success')
      } else {
        setTmdbStatus(res.error || 'Invalid key')
        showToast(res.error || 'Clave inválida', 'error')
      }
    } catch (e: any) {
      setTmdbStatus(e.message || 'Validation failed')
    } finally {
      setTmdbValidating(false)
    }
  }

  const handleCheckForUpdates = async () => {
    setUpdateChecking(true)
    setUpdateStatus(null)
    try {
      const electronAPI = (window as any).electronAPI
      // Set up one-shot listeners for the result
      const cleanupAvailable = electronAPI.onUpdateAvailable((version: string) => {
        setUpdateStatus(version)
        setUpdateChecking(false)
        cleanupAvailable()
        cleanupNotAvailable()
      })
      const cleanupNotAvailable = electronAPI.onUpdateNotAvailable(() => {
        setUpdateStatus(t.settings.updateUpToDate)
        setUpdateChecking(false)
        cleanupAvailable()
        cleanupNotAvailable()
      })
      await electronAPI.checkForUpdates()
      // If neither event fires within 15s, timeout
      setTimeout(() => {
        if (updateChecking) {
          setUpdateStatus(t.settings.updateCheckFailed)
          setUpdateChecking(false)
          cleanupAvailable()
          cleanupNotAvailable()
        }
      }, 15000)
    } catch (e: any) {
      setUpdateStatus(t.settings.updateCheckFailed)
      setUpdateChecking(false)
    }
  }

  const startAuth = async () => {
    try {
      const res = await api<any>('/auth/start')
      if (res.success && res.data) {
        setAuthData(res.data)
        pollTimer.current = window.setInterval(async () => {
          const pollRes = await api<any>(`/auth/poll/${res.data.device_code}`)
          if (pollRes.success) {
            if (pollTimer.current) window.clearInterval(pollTimer.current)
            setAuthData(null)
            showToast(t.settings.torboxLinked, 'success')
            const updated = await api<SettingsSchema>('/settings')
            setSettings(updated)
            if (updated.torbox_token) {
              await fetchTorboxUser()
            }
          }
        }, 5000)
      }
    } catch (e) {
      showToast(t.settings.authFailed, 'error')
    }
  }

  const planLabel = (plan: number): string => {
    const labels: Record<number, string> = {
      0: t.settings.freePlan,
      1: t.settings.essentialPlan,
      2: t.settings.proPlan,
      3: t.settings.standardPlan,
      4: t.settings.premiumPlan,
    }
    return labels[plan] || String(plan)
  }

  if (loading) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-0 sm:p-6 animate-fade-in" onClick={onClose}>
      <div className="glass-panel w-full max-w-2xl bg-bg-panel border border-border shadow-2xl flex flex-col h-full sm:h-auto max-h-[100dvh] sm:max-h-[92vh] rounded-none sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 sm:p-6 border-b border-border flex justify-between items-center bg-bg-deep">
          <h2 className="text-lg sm:text-xl font-black uppercase tracking-widest text-text-heading font-display">{t.settings.title}</h2>
          <button className="text-text-muted hover:text-danger font-bold text-xl" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSave} className="p-4 sm:p-6 flex flex-col gap-6 sm:gap-8 overflow-y-auto flex-1 min-h-0 sm:max-h-[70vh]">
          {/* Search — built-in */}
          <div className="space-y-4">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest border-b border-border pb-2">{t.settings.searchEngines}</h3>
            <div className="border border-border bg-bg-deep p-4">
              <p className="text-sm font-mono text-text-muted mb-3">{t.settings.builtInDesc}</p>
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono uppercase text-text-muted">
                  {t.settings.enginesBundled}
                </span>
              </div>
              {searchStatus && (
                <div className="mt-2 text-xs font-mono text-success">{searchStatus}</div>
              )}
              <button
                type="button"
                className="btn border border-border text-text-main hover:border-accent mt-3"
                onClick={handleTestMetaSearch}
                disabled={testingMetaSearch}
              >
                {testingMetaSearch ? t.settings.testing : t.settings.testEngines}
              </button>
              <button
                type="button"
                className="btn btn-accent mt-3 ml-3"
                onClick={handleUpdatePlugins}
                disabled={checkingPlugins}
              >
                {checkingPlugins ? t.settings.checkingPlugins : t.settings.updatePlugins}
              </button>
              {pluginStatus && (
                <div className="mt-2 text-xs font-mono text-success">{pluginStatus}</div>
              )}
            </div>
          </div>

          {/* Torbox */}
          <div className="space-y-4">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest border-b border-border pb-2">{t.settings.torboxIntegration}</h3>
            {authData ? (
              <div className="border border-border bg-bg-deep p-6 text-center space-y-4">
                <p className="font-mono text-sm text-text-main">
                  {t.settings.goToEnter}{' '}
                  <a href={authData.friendly_verification_url || "https://tor.box/link"} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    https://tor.box/link
                  </a>{' '}
                  {t.settings.andEnter}
                </p>
                <div className="text-4xl font-black tracking-[0.5em] text-accent font-mono py-4">{authData.code}</div>
                <div className="text-xs text-text-muted font-mono uppercase animate-pulse">{t.settings.waitingAuth}</div>
              </div>
            ) : (
              <div className="flex justify-center">
                {settings?.torbox_token ? (
                  <div className="flex flex-col gap-3 w-full">
                    <div className="bg-success/10 text-success border border-success p-3 text-center font-mono text-sm flex flex-col gap-1 items-center justify-center">
                      <span className="font-bold uppercase tracking-wider">{t.settings.accountLinked}</span>
                      {torboxUser && <span className="opacity-80 lowercase">{maskEmail(torboxUser.email || torboxUser.username || '')} &bull; {planLabel(torboxUser.plan)}</span>}
                    </div>
                    <button type="button" onClick={startAuth} className="btn border border-border text-text-main hover:border-accent">{t.settings.relinkAccount}</button>
                  </div>
                ) : (
                  <button type="button" onClick={startAuth} className="btn btn-accent w-full">{t.settings.linkTorbox}</button>
                )}
              </div>
            )}
          </div>

          {/* Real-Debrid */}
          <div className="space-y-4">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest border-b border-border pb-2">{t.settings.realdebridIntegration}</h3>
            {rdAuthData ? (
              <div className="border border-border bg-bg-deep p-6 text-center space-y-4">
                <p className="font-mono text-sm text-text-main">
                  {t.settings.goToEnter}{' '}
                  <a href={rdAuthData.verification_url || "https://real-debrid.com/device"} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    https://real-debrid.com/device
                  </a>{' '}
                  {t.settings.andEnter}
                </p>
                <div className="text-4xl font-black tracking-[0.5em] text-accent font-mono py-4">{rdAuthData.user_code}</div>
                <div className="text-xs text-text-muted font-mono uppercase animate-pulse">{t.settings.waitingAuth}</div>
              </div>
            ) : (
              <div className="flex justify-center">
                {settings?.realdebrid_token ? (
                  <div className="flex flex-col gap-3 w-full">
                    <div className="bg-success/10 text-success border border-success p-3 text-center font-mono text-sm flex flex-col gap-1 items-center justify-center">
                      <span className="font-bold uppercase tracking-wider">{t.settings.realdebridLinked}</span>
                      {rdUser && <span className="opacity-80 lowercase">{maskEmail(rdUser.email || rdUser.username)} &bull; {rdUser.type || (rdUser.premium && rdUser.premium > 0 ? 'Premium' : 'Free')}</span>}
                    </div>
                    <button type="button" onClick={startRdAuth} className="btn border border-border text-text-main hover:border-accent">{t.settings.relinkAccount}</button>
                  </div>
                ) : (
                  <button type="button" onClick={startRdAuth} className="btn btn-accent w-full">{t.settings.linkRealdebrid}</button>
                )}
              </div>
            )}
          </div>

          {/* Local Storage */}
          <div className="space-y-4">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest border-b border-border pb-2">{t.settings.localStorage}</h3>

            {/* TMDB API Key */}
            <div>
              <label className="block text-xs font-mono text-text-muted mb-2 uppercase">TMDB API Key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  className="input-field flex-1"
                  placeholder="Ingresa tu TMDB API key (gratis en themoviedb.org)"
                  value={settings?.tmdb_api_key || ''}
                  onChange={(e) => { setSettings((s) => s ? { ...s, tmdb_api_key: e.target.value } : null); setTmdbStatus(null) }}
                />
                <button
                  type="button"
                  className="btn btn-accent whitespace-nowrap text-xs"
                  onClick={handleValidateTmdb}
                  disabled={tmdbValidating || !settings?.tmdb_api_key}
                >
                  {tmdbValidating ? 'Validando...' : 'Validar'}
                </button>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-text-muted font-mono">
                  Gratis en themoviedb.org/settings/api
                </p>
                {tmdbStatus && (
                  <span className={`text-xs font-mono font-bold uppercase ${tmdbStatus === 'Valid key' ? 'text-success' : 'text-danger'}`}>
                    {tmdbStatus}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-mono text-text-muted mb-2 uppercase">{t.settings.downloadDest}</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="input-field flex-1"
                  placeholder="/data/downloads"
                  value={settings?.destination_folder || ''}
                  onChange={(e) => setSettings((s) => s ? { ...s, destination_folder: e.target.value } : null)}
                />
              </div>
              <p className="text-xs text-text-muted mt-1">Fallback used when no type is selected.</p>
            </div>

            <div>
              <label className="block text-xs font-mono text-text-muted mb-2 uppercase">Movies folder (Jellyfin)</label>
              <input
                type="text"
                className="input-field w-full"
                placeholder="/media/movies"
                value={settings?.movies_folder || ''}
                onChange={(e) => setSettings((s) => s ? { ...s, movies_folder: e.target.value } : null)}
              />
            </div>

            <div>
              <label className="block text-xs font-mono text-text-muted mb-2 uppercase">Series folder (Jellyfin)</label>
              <input
                type="text"
                className="input-field w-full"
                placeholder="/media/tv"
                value={settings?.series_folder || ''}
                onChange={(e) => setSettings((s) => s ? { ...s, series_folder: e.target.value } : null)}
              />
            </div>
            <div className="flex items-center gap-3 mt-4">
              <input
                type="checkbox"
                id="autoRemove"
                className="w-4 h-4 accent-accent bg-bg-deep border-border"
                checked={settings?.auto_remove_completed || false}
                onChange={(e) => setSettings((s) => s ? { ...s, auto_remove_completed: e.target.checked } : null)}
              />
              <label htmlFor="autoRemove" className="text-sm font-mono text-text-main cursor-pointer select-none">
                {t.settings.autoRemove}
              </label>
            </div>

            {/* Automation (MediaPilot monitor engine) */}
            <div className="mt-6 pt-4 border-t border-border space-y-4">
              <span className="section-label">{t.settings.automationTitle}</span>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="monitorEnabled"
                  className="w-4 h-4 accent-accent bg-bg-deep border-border"
                  checked={settings?.monitor_enabled ?? true}
                  onChange={(e) => setSettings((s) => s ? { ...s, monitor_enabled: e.target.checked } : null)}
                />
                <label htmlFor="monitorEnabled" className="text-sm font-mono text-text-main cursor-pointer select-none">
                  {t.settings.monitorEnabled}
                </label>
              </div>
              <div>
                <label className="block text-xs font-mono text-text-muted mb-2 uppercase">{t.settings.defaultLanguage}</label>
                <select
                  className="select-field"
                  value={settings?.language_profile || 'latino_first'}
                  onChange={(e) => setSettings((s) => s ? { ...s, language_profile: e.target.value } : null)}
                >
                  <option value="latino_first">{t.watchlist.latinoFirst}</option>
                  <option value="latino_only">{t.watchlist.latinoOnly}</option>
                  <option value="english_first">{t.watchlist.englishFirst}</option>
                </select>
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-xs font-mono text-text-muted mb-2 uppercase">{t.settings.intervalLabel}</label>
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    step={5}
                    className="input-field w-full"
                    value={settings?.monitor_interval_minutes ?? 30}
                    onChange={(e) => setSettings((s) => s ? { ...s, monitor_interval_minutes: Math.max(5, Number(e.target.value) || 30) } : null)}
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-mono text-text-muted mb-2 uppercase">{t.settings.maxConcurrentLabel}</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    className="input-field w-full"
                    value={settings?.max_concurrent_downloads ?? 3}
                    onChange={(e) => setSettings((s) => s ? { ...s, max_concurrent_downloads: Math.min(10, Math.max(1, Number(e.target.value) || 3)) } : null)}
                  />
                  <p className="text-xs text-text-muted mt-1">{t.settings.maxConcurrentHint}</p>
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-mono text-text-muted mb-2 uppercase">{t.settings.serviceLabel}</label>
                  <select
                    className="select-field"
                    value={settings?.automation_service || 'torbox'}
                    onChange={(e) => setSettings((s) => s ? { ...s, automation_service: e.target.value } : null)}
                  >
                    <option value="torbox">TorBox</option>
                    <option value="realdebrid">Real-Debrid</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="automationFailover"
                  className="w-4 h-4 accent-accent bg-bg-deep border-border"
                  checked={settings?.automation_failover ?? true}
                  onChange={(e) => setSettings((s) => s ? { ...s, automation_failover: e.target.checked } : null)}
                />
                <label htmlFor="automationFailover" className="text-sm font-mono text-text-main cursor-pointer select-none">
                  {t.settings.failoverLabel}
                </label>
              </div>
              <div>
                <label className="block text-xs font-mono text-text-muted mb-2 uppercase">{t.settings.maxSizeLabel}</label>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] font-mono text-text-muted mb-1">{t.settings.maxMovieSize}</label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="input-field w-full"
                      placeholder="0"
                      value={settings?.max_movie_size_gb ?? 0}
                      onChange={(e) => setSettings((s) => s ? { ...s, max_movie_size_gb: Math.max(0, Number(e.target.value) || 0) } : null)}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono text-text-muted mb-1">{t.settings.maxSeriesSize}</label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="input-field w-full"
                      placeholder="0"
                      value={settings?.max_series_size_gb ?? 0}
                      onChange={(e) => setSettings((s) => s ? { ...s, max_series_size_gb: Math.max(0, Number(e.target.value) || 0) } : null)}
                    />
                  </div>
                </div>
                <p className="text-xs text-text-muted mt-1">{t.settings.maxSizeHint}</p>
              </div>

              {/* Jellyfin (para el refresco tras borrar en Biblioteca) */}
              <div className="mt-4">
                <label className="block text-xs font-mono text-text-muted mb-2 uppercase">{t.settings.jellyfinTitle}</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-mono text-text-muted mb-1">{t.settings.jellyfinUrl}</label>
                    <input
                      className="input-field w-full"
                      placeholder="http://localhost:8096"
                      value={settings?.jellyfin_url || ''}
                      onChange={(e) => setSettings((s) => s ? { ...s, jellyfin_url: e.target.value } : null)}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono text-text-muted mb-1">{t.settings.jellyfinKey}</label>
                    <input
                      className="input-field w-full"
                      type="password"
                      placeholder="API key"
                      value={settings?.jellyfin_api_key || ''}
                      onChange={(e) => setSettings((s) => s ? { ...s, jellyfin_api_key: e.target.value } : null)}
                    />
                  </div>
                </div>
                <p className="text-xs text-text-muted mt-1">{t.settings.jellyfinHint}</p>
              </div>
            </div>

            {/* App Updates */}
            <div className="mt-6 pt-4 border-t border-border">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-xs font-mono text-text-muted uppercase">{t.settings.updateTitle}</span>
                  {updateStatus && (
                    <span className={`text-xs font-mono font-bold uppercase mt-1 ${
                      updateStatus === t.settings.updateUpToDate ? 'text-success'
                      : updateStatus === t.settings.updateCheckFailed ? 'text-danger'
                      : 'text-accent'
                    }`}>
                      {updateStatus === t.settings.updateUpToDate ? updateStatus
                        : updateStatus === t.settings.updateCheckFailed ? updateStatus
                        : `v${updateStatus}`}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn border border-border text-text-main hover:border-accent text-xs font-mono"
                  onClick={handleCheckForUpdates}
                  disabled={updateChecking}
                >
                  {updateChecking ? t.settings.updateChecking : t.settings.checkForUpdates}
                </button>
              </div>
            </div>
          </div>

        </form>
        <div className="p-6 border-t border-border bg-bg-deep flex gap-4">
          <button type="button" onClick={onClose} className="btn border border-border flex-1">{t.settings.cancel}</button>
          <button onClick={handleSave} className="btn btn-accent flex-1">{t.settings.saveConfig}</button>
        </div>
      </div>
    </div>
  )
}
