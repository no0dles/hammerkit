// Verifies getLogger dispatches to the right logger by name and rejects an
// unknown mode via failNever — the actual loggers are tested elsewhere.

vi.mock('../logging/grouped-logger', () => ({ groupedLogger: vi.fn(() => 'grouped-instance') }))
vi.mock('../logging/live-logger', () => ({ liveLogger: vi.fn(() => 'live-instance') }))
vi.mock('../logging/interactive-logger', () => ({ interactiveLogger: vi.fn(() => 'interactive-instance') }))

import { getLogger } from './get-logger'

describe('getLogger', () => {
  it('returns the grouped logger for mode "grouped"', () => {
    expect(getLogger('grouped', {} as any, {} as any)).toBe('grouped-instance')
  })

  it('returns the live logger for mode "live"', () => {
    expect(getLogger('live', {} as any, {} as any)).toBe('live-instance')
  })

  it('returns the interactive logger for mode "interactive"', () => {
    expect(getLogger('interactive', {} as any, {} as any)).toBe('interactive-instance')
  })

  it('throws on an unknown mode (failNever)', () => {
    expect(() => getLogger('bogus' as never, {} as any, {} as any)).toThrow()
  })
})
