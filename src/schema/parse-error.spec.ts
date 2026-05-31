import { z } from 'zod'
import { ParseError } from './parse-error'

describe('ParseError', () => {
  it('wraps a ZodError with the offending build-file path', () => {
    const result = z.object({ name: z.string() }).safeParse({})
    if (result.success) {
      throw new Error('precondition: expected the safeParse to fail')
    }
    const err = new ParseError(result.error, '/work/.hammerkit.yaml')
    expect(err).toBeInstanceOf(Error)
    expect(err.zod).toBe(result.error)
    expect(err.buildFilePath).toBe('/work/.hammerkit.yaml')
    expect(err.message).toBe('parse error')
  })
})
