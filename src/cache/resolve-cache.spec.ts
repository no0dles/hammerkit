import { resolveCache, withBuiltinCaches } from './resolve-cache'

describe('resolveCache', () => {
  const catalog = withBuiltinCaches({
    s3: { method: 'modify-date', backend: { type: 'local', path: '/tmp/fake' } },
  })

  it('uses the default cache when no ref is given', () => {
    const r = resolveCache(undefined, catalog, 'taskA')
    expect(r.name).toBe('default')
    expect(r.method).toBe('checksum')
    expect(r.backend.type).toBe('local')
    expect(r.implicit).toBe(true)
  })

  it('treats a string ref as a method override on default', () => {
    const r = resolveCache('modify-date', catalog, 'taskA')
    expect(r.name).toBe('default')
    expect(r.method).toBe('modify-date')
    expect(r.backend.type).toBe('local')
    expect(r.implicit).toBe(false)
  })

  it('uses none method when "none" string shorthand is used', () => {
    const r = resolveCache('none', catalog, 'taskA')
    expect(r.method).toBe('none')
  })

  it('resolves a named reference and keeps its declared method', () => {
    const r = resolveCache({ name: 's3' }, catalog, 'taskA')
    expect(r.name).toBe('s3')
    expect(r.method).toBe('modify-date')
  })

  it('overrides the named cache method when the task sets one', () => {
    const r = resolveCache({ name: 's3', method: 'checksum' }, catalog, 'taskA')
    expect(r.name).toBe('s3')
    expect(r.method).toBe('checksum')
  })

  it('throws when an unknown name is referenced', () => {
    expect(() => resolveCache({ name: 'missing' }, catalog, 'taskA')).toThrow(
      /cache "missing" referenced by task "taskA"/
    )
  })

  it('seeds default and none even when nothing is declared', () => {
    const empty = withBuiltinCaches(undefined)
    expect(empty.default.backend.type).toBe('local')
    expect(empty.none.backend.type).toBe('local')
  })

  it('lets the user override the built-in default', () => {
    const cat = withBuiltinCaches({
      default: { method: 'modify-date', backend: { type: 'local', path: '/tmp/x' } },
    })
    const r = resolveCache(undefined, cat, 'taskA')
    expect(r.method).toBe('modify-date')
  })
})
