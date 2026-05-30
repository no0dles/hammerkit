import { AbortError, checkForAbort } from './abort'

describe('checkForAbort', () => {
  it('throws AbortError when the signal is already aborted', () => {
    const ctrl = new AbortController()
    ctrl.abort()
    expect(() => checkForAbort(ctrl.signal)).toThrow(AbortError)
  })

  it('does nothing when the signal is live', () => {
    const ctrl = new AbortController()
    expect(() => checkForAbort(ctrl.signal)).not.toThrow()
  })

  it('AbortError extends Error', () => {
    expect(new AbortError()).toBeInstanceOf(Error)
  })
})
