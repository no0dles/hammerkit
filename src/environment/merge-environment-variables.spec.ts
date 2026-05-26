import { mergeEnvironmentVariables } from './merge-environment-variables'

describe('mergeEnvironmentVariables', () => {
  it('copies the base map and stringifies values', () => {
    expect(mergeEnvironmentVariables({ A: 'one', B: 2 }, null)).toEqual({ A: 'one', B: '2' })
  })

  it('returns an empty map when both inputs are nullish', () => {
    expect(mergeEnvironmentVariables(null, undefined)).toEqual({})
  })

  it('adds extension keys that the base does not define', () => {
    expect(mergeEnvironmentVariables({ A: '1' }, { B: '2' })).toEqual({ A: '1', B: '2' })
  })

  it('keeps the base value when both maps define the same key (base wins)', () => {
    expect(mergeEnvironmentVariables({ A: 'base' }, { A: 'override' })).toEqual({ A: 'base' })
  })

  it('drops falsy extension values', () => {
    expect(mergeEnvironmentVariables({}, { A: '', B: 0 })).toEqual({})
  })

  it('handles an undefined base with an extension', () => {
    expect(mergeEnvironmentVariables(undefined, { A: '1' })).toEqual({ A: '1' })
  })
})
