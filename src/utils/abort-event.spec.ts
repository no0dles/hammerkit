import { listenOnAbort, waitOnAbort } from './abort-event'

describe('abort-event', () => {
  describe('listenOnAbort', () => {
    it('fires immediately when the signal is already aborted', () => {
      const ctrl = new AbortController()
      ctrl.abort()
      const cb = jest.fn()
      const handle = listenOnAbort(ctrl.signal, cb)
      expect(cb).toHaveBeenCalledTimes(1)
      // close on a pre-aborted listener is a no-op; calling it must not throw.
      expect(() => handle.close()).not.toThrow()
    })

    it('fires when the signal is aborted later', () => {
      const ctrl = new AbortController()
      const cb = jest.fn()
      listenOnAbort(ctrl.signal, cb)
      expect(cb).not.toHaveBeenCalled()
      ctrl.abort()
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('does not fire after close()', () => {
      const ctrl = new AbortController()
      const cb = jest.fn()
      const handle = listenOnAbort(ctrl.signal, cb)
      handle.close()
      ctrl.abort()
      expect(cb).not.toHaveBeenCalled()
    })
  })

  describe('waitOnAbort', () => {
    it('resolves immediately when already aborted', async () => {
      const ctrl = new AbortController()
      ctrl.abort()
      await expect(waitOnAbort(ctrl.signal)).resolves.toBeUndefined()
    })

    it('resolves when the signal is aborted later', async () => {
      const ctrl = new AbortController()
      const pending = waitOnAbort(ctrl.signal)
      ctrl.abort()
      await expect(pending).resolves.toBeUndefined()
    })
  })
})
