import { failNever } from './fail-never'

describe('failNever', () => {
  it('throws an error with the given message', () => {
    expect(() => failNever('value' as never, 'unexpected')).toThrow('unexpected')
  })
})
