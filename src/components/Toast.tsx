interface ToastProps {
  message: string
  type: 'success' | 'error'
  visible: boolean
}

export function Toast({ message, type, visible }: ToastProps) {
  if (!visible) return null

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 glass-panel p-4 px-6 border-l-4 font-mono text-sm uppercase animate-slide-up ${
        type === 'error' ? 'border-l-danger text-danger' : 'border-l-success text-success'
      }`}
    >
      {message}
    </div>
  )
}
