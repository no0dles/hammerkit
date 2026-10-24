import { EventEmitter } from 'events'
import { ABORT_SIGNALS, abortOnSignals, takeOverSignal } from './abort-on-signals'

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

  it('removes its listeners again', () => {
    const source = new EventEmitter()
    const abortCtrl = new AbortController()
    abortOnSignals(source, abortCtrl)()

    ABORT_SIGNALS.forEach((signal) => expect(source.listenerCount(signal)).toBe(0))
  })
})

describe('takeOverSignal', () => {
  it('calls the handler instead of aborting, and only for that signal', () => {
    const source = new EventEmitter()
    const abortCtrl = new AbortController()
    abortOnSignals(source, abortCtrl)
    const handler = vi.fn()
    const release = takeOverSignal(source, 'SIGHUP', handler)

    source.emit('SIGHUP')
    source.emit('SIGHUP')
    expect(handler).toHaveBeenCalledTimes(2)
    expect(abortCtrl.signal.aborted).toBe(false)

    source.emit('SIGTERM')
    expect(abortCtrl.signal.aborted).toBe(true)
    release()
  })

  it('gives the signal back to the abort once released', () => {
    const source = new EventEmitter()
    const abortCtrl = new AbortController()
    abortOnSignals(source, abortCtrl)
    const handler = vi.fn()
    const release = takeOverSignal(source, 'SIGHUP', handler)
    release()
    // a second release does not give back a signal another holder still has
    const other = takeOverSignal(source, 'SIGHUP', () => undefined)
    release()

    source.emit('SIGHUP')
    expect(abortCtrl.signal.aborted).toBe(false)
    other()
    source.emit('SIGHUP')
    expect(handler).not.toHaveBeenCalled()
    expect(abortCtrl.signal.aborted).toBe(true)
  })
})
