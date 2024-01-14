import { number, record, string, union } from 'zod'

export const envsSchema = record(union([string(), number()])).describe(
  'Environment values for the current build task\nhttps://no0dles.gitbook.io/hammerkit/build-file/environment-variables'
)
