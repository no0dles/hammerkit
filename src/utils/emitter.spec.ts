import { emitter } from './emitter'

describe('emitter', () => {
  it('invokes every registered listener on emit', () => {
    const e = emitter<number>()
    const a = vi.fn()
    const b = vi.fn()
    e.on(a)
    e.on(b)
    e.emit(42)
    expect(a).toHaveBeenCalledWith(42)
    expect(b).toHaveBeenCalledWith(42)
  })

  it('emit with no listeners is a no-op', () => {
    const e = emitter<string>()
    expect(() => e.emit('noop')).not.toThrow()
  })

  it('close() removes the listener from future emits', () => {
    const e = emitter<number>()
    const cb = vi.fn()
    const handle = e.on(cb)
    handle.close()
    e.emit(1)
    expect(cb).not.toHaveBeenCalled()
  })

  it('close() called twice is safe (no listener to remove)', () => {
    const e = emitter<number>()
    const handle = e.on(vi.fn())
    handle.close()
    expect(() => handle.close()).not.toThrow()
  })
})
