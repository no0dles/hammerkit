import { lazyResolver } from './lazy-resolver'

describe('lazyResolver', () => {
  it('calls the factory once and memoizes the result', () => {
    const factory = vi.fn(() => 'value')
    const resolve = lazyResolver(factory)
    expect(resolve()).toBe('value')
    expect(resolve()).toBe('value')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('memoizes a falsy result so the factory still runs only once', () => {
    const factory = vi.fn(() => 0)
    const resolve = lazyResolver(factory)
    expect(resolve()).toBe(0)
    expect(resolve()).toBe(0)
    expect(factory).toHaveBeenCalledTimes(1)
  })
})
