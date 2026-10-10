// Ctrl-C (SIGINT), a CI job being cancelled or a supervisor stopping hammerkit
// (SIGTERM) and a closed terminal (SIGHUP) all stop the run the same way: abort,
// so services are removed and local tasks' process groups are killed. Without a
// handler Node exits on SIGTERM/SIGHUP at once and leaves both behind.
export const ABORT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown
}

export function abortOnSignals(source: SignalSource, abortCtrl: AbortController): void {
  for (const signal of ABORT_SIGNALS) {
    source.on(signal, () => {
      abortCtrl.abort()
    })
  }
}
