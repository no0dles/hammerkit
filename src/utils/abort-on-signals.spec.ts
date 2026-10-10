import { EventEmitter } from 'events'
import { ABORT_SIGNALS, abortOnSignals } from './abort-on-signals'

describe('abortOnSignals', () => {
  it.each(ABORT_SIGNALS)('aborts the run on %s', (signal) => {
    const source = new EventEmitter()
    const abortCtrl = new AbortController()
    abortOnSignals(source, abortCtrl)

    source.emit(signal)

    expect(abortCtrl.signal.aborted).toBe(true)
  })

  it('covers SIGINT, SIGTERM and SIGHUP', () => {
    expect(ABORT_SIGNALS).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
  })
})
