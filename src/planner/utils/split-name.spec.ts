import { splitName } from './split-name'

describe('split-name', () => {
  it('should split test:bar', () => {
    const result = splitName('test:bar')
    expect(result.name).toEqual('bar')
    expect(result.prefix).toEqual('test')
  })

  it('should not split test', () => {
    const result = splitName('test')
    expect(result.name).toEqual('test')
    expect(result.prefix).toEqual(undefined)
  })
})
