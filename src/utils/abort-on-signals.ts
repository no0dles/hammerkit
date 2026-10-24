// Ctrl-C (SIGINT), a CI job being cancelled or a supervisor stopping hammerkit
// (SIGTERM) and a closed terminal (SIGHUP) all stop the run the same way: abort,
// so services are removed and local tasks' process groups are killed. Without a
// handler Node exits on SIGTERM/SIGHUP at once and leaves both behind.
export const ABORT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}

// signals a running command gives a meaning of its own (the server reloads its
// entitlements on SIGHUP), counted by how many hold them: they don't abort the run
const takenOver = new Map<NodeJS.Signals, number>()

/**
 * Stops the run on the abort signals, all but those a command took over with
 * `takeOverSignal`. Returns what removes the listeners again.
 */
export function abortOnSignals(source: SignalSource, abortCtrl: AbortController): () => void {
  const listeners = ABORT_SIGNALS.map((signal) => {
    const listener = () => {
      if (!takenOver.get(signal)) {
        abortCtrl.abort()
      }
    }
    source.on(signal, listener)
    return { signal, listener }
  })
  return () => listeners.forEach(({ signal, listener }) => source.off(signal, listener))
}

/**
 * Calls `handler` on `signal` instead of stopping the run, until the returned function
 * gives the signal back.
 */
export function takeOverSignal(source: SignalSource, signal: NodeJS.Signals, handler: () => void): () => void {
  takenOver.set(signal, (takenOver.get(signal) ?? 0) + 1)
  source.on(signal, handler)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    source.off(signal, handler)
    takenOver.set(signal, (takenOver.get(signal) ?? 1) - 1)
  }
}
