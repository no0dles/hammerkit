import { number, record, string, union } from 'zod'

export const envsSchema = record(union([string(), number()])).describe(
  'Environment values for the current build task\nhttps://hammerkit.dev/docs/build-file/environment-variables'
)
