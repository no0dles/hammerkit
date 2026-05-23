import { union, z } from 'zod'
import { BuildFileContainerTaskSchema, buildFileContainerTaskSchema } from './build-file-container-task-schema'
import { BuildFileLocalTaskSchema, buildFileLocalTaskSchema } from './build-file-local-task-schema'

export const buildFileTaskSchema = union([buildFileContainerTaskSchema, buildFileLocalTaskSchema])

export type BuildFileTaskSchema = z.infer<typeof buildFileTaskSchema>

export const isBuildFileContainerTaskSchema = (val: BuildFileTaskSchema): val is BuildFileContainerTaskSchema =>
  'image' in val

export const isBuildFileLocalTaskSchema = (val: BuildFileTaskSchema): val is BuildFileLocalTaskSchema =>
  !('image' in val)
