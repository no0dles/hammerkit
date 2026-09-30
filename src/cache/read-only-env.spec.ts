import { isCacheReadOnly } from './read-only'

describe('isCacheReadOnly', () => {
  it('is enabled by the flag regardless of the environment', () => {
    expect(isCacheReadOnly(true, {})).toBe(true)
  })

  it.each(['1', 'true', 'yes', 'TRUE'])('is enabled by HAMMERKIT_CACHE_READ_ONLY=%s', (value) => {
    expect(isCacheReadOnly(false, { HAMMERKIT_CACHE_READ_ONLY: value })).toBe(true)
  })

  it.each(['', '0', 'false', 'no'])('is disabled by HAMMERKIT_CACHE_READ_ONLY=%s', (value) => {
    expect(isCacheReadOnly(false, { HAMMERKIT_CACHE_READ_ONLY: value })).toBe(false)
  })

  it('is disabled when neither is set', () => {
    expect(isCacheReadOnly(undefined, {})).toBe(false)
  })
})
