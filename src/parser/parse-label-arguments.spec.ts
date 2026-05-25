import { parseLabelArguments } from './parse-label-arguments'

describe('parse-label-arguments', () => {
  it('parses a single key=value argument', () => {
    expect(parseLabelArguments(['app=web'])).toEqual({ app: ['web'] })
  })

  it('collects multiple values for the same key', () => {
    expect(parseLabelArguments(['app=web', 'app=api'])).toEqual({ app: ['web', 'api'] })
  })

  it('dedupes repeated values', () => {
    expect(parseLabelArguments(['app=web', 'app=web'])).toEqual({ app: ['web'] })
  })

  it('keeps distinct keys separate', () => {
    expect(parseLabelArguments(['app=web', 'tier=frontend'])).toEqual({ app: ['web'], tier: ['frontend'] })
  })

  it('returns an empty object for no arguments', () => {
    expect(parseLabelArguments([])).toEqual({})
  })

  it('throws when an argument has no value', () => {
    expect(() => parseLabelArguments(['app'])).toThrow('invalid label app')
  })

  it('throws when an argument has multiple equals signs', () => {
    expect(() => parseLabelArguments(['app=web=extra'])).toThrow('invalid label app=web=extra')
  })
})
