import { number, record, string, union } from 'zod'

export const labelsSchema = record(union([string(), number()]))
