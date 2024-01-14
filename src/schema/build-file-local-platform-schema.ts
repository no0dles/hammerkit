import { literal, object, union } from 'zod'

export const buildFileLocalPlatformSchema = object({
  os: union([literal('win'), literal('macos'), literal('linux')]).optional(),
  arch: union([literal('arm64'), literal('arm')]).optional(),
})
