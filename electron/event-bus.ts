// Tiny pub/sub used by both the Electron desktop app (IPC -> window) and the
// headless web server (SSE). Replaces direct `mainWindow.webContents.send`
// calls so the backend logic is transport-agnostic.
type Listener = (data?: any) => void

const listeners = new Map<string, Set<Listener>>()

export const eventBus = {
  on(channel: string, fn: Listener): () => void {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(fn)
    return () => eventBus.off(channel, fn)
  },
  off(channel: string, fn: Listener): void {
    listeners.get(channel)?.delete(fn)
  },
  emit(channel: string, data?: any): void {
    listeners.get(channel)?.forEach((fn) => {
      try {
        fn(data)
      } catch (err) {
        console.error(`[event-bus] listener error on ${channel}:`, err)
      }
    })
  },
}
