import { parseBoolean } from './parse-boolean'
import { ParseContext } from './parse-context'

describe('parse-boolean', () => {
  const context: ParseContext = { type: 'task', name: 'example', fileName: '' }

  it('should parse true', () => {
    const value = parseBoolean(context, 'watch', true, false)
    expect(value).toBeTruthy()
  })
  it('should parse "true"', () => {
    const value = parseBoolean(context, 'watch', 'true', false)
    expect(value).toBeTruthy()
  })
  it('should parse "TRUE"', () => {
    const value = parseBoolean(context, 'watch', 'TRUE', false)
    expect(value).toBeTruthy()
  })
  it('should parse false', () => {
    const value = parseBoolean(context, 'watch', false, false)
    expect(value).toBeFalsy()
  })
  it('should parse "false"', () => {
    const value = parseBoolean(context, 'watch', 'false', false)
    expect(value).toBeFalsy()
  })
  it('should parse "FALSE"', () => {
    const value = parseBoolean(context, 'watch', 'FALSE', false)
    expect(value).toBeFalsy()
  })

  it('should allow 2', () => {
    expect(parseBoolean(context, 'watch', 2, false)).toThrow()
  })

  it('should allow "test"', () => {
    expect(parseBoolean(context, 'watch', 'test', false)).toThrow()
  })

  it('should parse null if optional', () => {
    const value = parseBoolean(context, 'watch', null, true)
    expect(value).toBeNull()
  })

  it('should parse undefined if optional', () => {
    const value = parseBoolean(context, 'watch', undefined, true)
    expect(value).toBeNull()
  })

  it('should not allow null if optional', () => {
    expect(parseBoolean(context, 'watch', null, false)).toThrow()
  })
})
