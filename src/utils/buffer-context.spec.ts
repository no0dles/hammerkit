import { BufferContext } from './buffer-context'

describe('BufferContext', () => {
  it('returns null for current of an unknown id', () => {
    const ctx = new BufferContext<number>(10)
    expect(ctx.current('missing')).toBeNull()
  })

  it('returns an empty array for get of an unknown id', () => {
    const ctx = new BufferContext<number>(10)
    expect(ctx.get('missing')).toEqual([])
  })

  it('tracks the latest value per id', () => {
    const ctx = new BufferContext<number>(10)
    ctx.add('a', 1)
    ctx.add('a', 2)
    ctx.add('b', 9)
    expect(ctx.current('a')).toBe(2)
    expect(ctx.current('b')).toBe(9)
  })

  it('keeps per-id and global buffers', () => {
    const ctx = new BufferContext<number>(10)
    ctx.add('a', 1)
    ctx.add('b', 2)
    expect(ctx.get('a')).toEqual([1])
    expect(ctx.get('b')).toEqual([2])
    expect(ctx.get()).toEqual([1, 2])
  })

  it('evicts the oldest global entry once an id exceeds the limit', () => {
    const ctx = new BufferContext<number>(2)
    ctx.add('a', 1)
    ctx.add('a', 2)
    ctx.add('a', 3)
    expect(ctx.get()).toEqual([2, 3])
    expect(ctx.current('a')).toBe(3)
  })
})
