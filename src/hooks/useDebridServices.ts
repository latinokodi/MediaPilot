import { useState, useCallback, useEffect } from 'react'
import { api } from './useApi'

interface DebridServicesState {
  hasTorbox: boolean
  hasRealdebrid: boolean
  downloadService: 'torbox' | 'realdebrid'
  setDownloadService: (service: 'torbox' | 'realdebrid') => void
}

export function useDebridServices(): DebridServicesState {
  const [hasTorbox, setHasTorbox] = useState(false)
  const [hasRealdebrid, setHasRealdebrid] = useState(false)
  const [downloadService, setDownloadService] = useState<'torbox' | 'realdebrid'>('torbox')

  const refreshFromSettings = useCallback((settings: any) => {
    const tb = !!settings?.torbox_token
    const rd = !!settings?.realdebrid_token
    setHasTorbox(tb)
    setHasRealdebrid(rd)
    if (tb && !rd) setDownloadService('torbox')
    else if (!tb && rd) setDownloadService('realdebrid')
  }, [])

  useEffect(() => {
    api<any>('/settings').then(refreshFromSettings).catch(() => {})
  }, [refreshFromSettings])

  return { hasTorbox, hasRealdebrid, downloadService, setDownloadService }
}
