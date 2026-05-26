// The factory registry registers `local` and `s3` at import time. We can
// exercise createCacheBackend for both registered types and the unknown-type
// failure without needing the AWS SDK at runtime (`local` is real; for `s3`
// we register a fake under a fresh type name).

import { createCacheBackend, registerCacheBackend } from './cache-backend-registry'

describe('createCacheBackend', () => {
  it('builds a local backend from a {type:"local"} spec', () => {
    const backend = createCacheBackend({ type: 'local' } as any)
    expect(backend.type).toBe('local')
  })

  it('throws on an unknown backend type', () => {
    expect(() => createCacheBackend({ type: 'unknown-backend-xyz' } as any)).toThrow(
      /unknown cache backend type: unknown-backend-xyz/
    )
  })

  it('dispatches to a registered custom factory', () => {
    const fakeBackend = { type: 'fake' } as any
    registerCacheBackend('fake-backend', () => fakeBackend)
    expect(createCacheBackend({ type: 'fake-backend' } as any)).toBe(fakeBackend)
  })
})
