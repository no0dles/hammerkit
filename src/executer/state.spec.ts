import { State } from './state'

describe('State', () => {
  it('exposes the initial value via `current`', () => {
    const s = new State<number>(7)
    expect(s.current).toBe(7)
  })

  it('set() updates current and returns the new value', () => {
    const s = new State<number>(0)
    expect(s.set(3)).toBe(3)
    expect(s.current).toBe(3)
  })

  it('notifies every registered listener on set()', () => {
    const s = new State<number>(0)
    const a = vi.fn()
    const b = vi.fn()
    s.on('a', a)
    s.on('b', b)
    s.set(1)
    expect(a).toHaveBeenCalledWith(1)
    expect(b).toHaveBeenCalledWith(1)
  })

  it('close() on a listener handle stops further notifications', () => {
    const s = new State<number>(0)
    const cb = vi.fn()
    const handle = s.on('k', cb)
    handle.close()
    s.set(1)
    expect(cb).not.toHaveBeenCalled()
  })

  it('close() on an already-removed listener is a no-op', () => {
    const s = new State<number>(0)
    const handle = s.on('k', vi.fn())
    handle.close()
    expect(() => handle.close()).not.toThrow()
  })

  it('forwards sub-state changes to its own listeners', () => {
    const sub = new State<number>(0)
    const parent = new State<string>('p', { subStates: [sub] })
    const cb = vi.fn()
    parent.on('any', cb)
    // emit a 'sub-state-forward' on the sub-state to trigger parent notification
    sub.set(1) // sub.set notifies its listeners under whatever keys are registered
    // The parent registered for 'sub-state-forward' on the sub; sub.set calls
    // notifyListeners which dispatches to all listeners regardless of key, so
    // the parent's forwarding listener fires and notifies parent listeners.
    expect(cb).toHaveBeenCalledWith('p')
  })

  it('close() runs the onDestroy callback', () => {
    const onDestroy = vi.fn()
    const s = new State<number>(0, { onDestroy })
    s.close()
    expect(onDestroy).toHaveBeenCalledTimes(1)
  })

  it('close() detaches sub-state forwarders', () => {
    const sub = new State<number>(0)
    const parent = new State<string>('p', { subStates: [sub] })
    const cb = vi.fn()
    parent.on('any', cb)
    parent.close()
    sub.set(1)
    expect(cb).not.toHaveBeenCalled()
  })
})
