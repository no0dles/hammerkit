import { ZodError } from 'zod'

export class ParseError extends Error {
  constructor(public zod: ZodError, public buildFilePath: string) {
    super('parse error')
  }
}
