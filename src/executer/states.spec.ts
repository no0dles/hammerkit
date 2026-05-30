import { getDuration } from './states'

describe('getDuration', () => {
  it('returns the milliseconds elapsed since the given start date', () => {
    const started = new Date(Date.now() - 250)
    const d = getDuration(started)
    expect(d).toBeGreaterThanOrEqual(250)
  })

  it('returns 0 (or very small) for a start date that is essentially now', () => {
    expect(getDuration(new Date())).toBeGreaterThanOrEqual(0)
  })
})
