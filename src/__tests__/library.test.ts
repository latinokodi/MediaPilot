import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getElectronAPI, webAPI } from '../types/electron'

describe('Library API contract', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    delete (window as any).electronAPI
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('falls back to webAPI when window.electronAPI is undefined', () => {
    const ea = getElectronAPI()
    expect(ea).toBe(webAPI)
    expect(typeof ea?.getLibrary).toBe('function')
    expect(typeof ea?.deleteLibraryItem).toBe('function')
    expect(typeof ea?.getLibraryPoster).toBe('function')
  })

  it('prefers window.electronAPI when running in Electron desktop', () => {
    const mockElectronAPI = {
      getLibrary: vi.fn().mockResolvedValue({ success: true, data: { movies: [], series: [] } }),
      deleteLibraryItem: vi.fn().mockResolvedValue({ success: true }),
      getLibraryPoster: vi.fn().mockResolvedValue('data:image/jpeg;base64,abc'),
    } as any

    ;(window as any).electronAPI = mockElectronAPI

    const ea = getElectronAPI()
    expect(ea).toBe(mockElectronAPI)
  })

  it('webAPI.getLibrary fetches /api/library', async () => {
    const mockData = { success: true, data: { movies: [], series: [] } }
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: vi.fn().mockResolvedValue(mockData),
    } as any)

    const result = await webAPI.getLibrary()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/library', expect.objectContaining({ method: 'GET' }))
    expect(result).toEqual(mockData)
  })

  it('webAPI.deleteLibraryItem sends POST to /api/library/delete', async () => {
    const payload = { type: 'movie', dir: 'Test (2024)', title: 'Test', forgetHistory: true }
    const mockData = { success: true, data: { ok: true, freedBytes: 1024 } }
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: vi.fn().mockResolvedValue(mockData),
    } as any)

    const result = await webAPI.deleteLibraryItem(payload)
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/library/delete', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(payload),
    }))
    expect(result).toEqual(mockData)
  })

  it('webAPI.getLibraryPoster resolves poster URL for HTTP web mode', async () => {
    const url = await webAPI.getLibraryPoster('movie', 'Película (2024)')
    expect(url).toBe('/api/library/poster?t=movie&f=Pel%C3%ADcula%20(2024)')
  })
})
