import { union, z } from 'zod'
import {
  BuildFileContainerTaskSchema,
  buildFileContainerTaskSchema,
  buildFileExtendingContainerTaskSchema,
} from './build-file-container-task-schema'
import { BuildFileLocalTaskSchema, buildFileLocalTaskSchema } from './build-file-local-task-schema'
import { BuildFileImageBuildTaskSchema, buildFileImageBuildTaskSchema } from './build-file-image-build-schema'

// A task with `build` is tried first: it fails at once without one, and with one its own
// errors are reported, not that the other kinds don't know `build` (zod gives the first
// option's errors that aren't fatal).
export const buildFileTaskSchema = union([
  buildFileImageBuildTaskSchema,
  buildFileContainerTaskSchema,
  buildFileLocalTaskSchema,
  buildFileExtendingContainerTaskSchema,
])

export type BuildFileTaskSchema = z.infer<typeof buildFileTaskSchema>

export const isBuildFileContainerTaskSchema = (val: BuildFileTaskSchema): val is BuildFileContainerTaskSchema =>
  'image' in val

export const isBuildFileImageBuildTaskSchema = (val: BuildFileTaskSchema): val is BuildFileImageBuildTaskSchema =>
  'build' in val

export const isBuildFileLocalTaskSchema = (val: BuildFileTaskSchema): val is BuildFileLocalTaskSchema =>
  !('image' in val) && !('build' in val)
