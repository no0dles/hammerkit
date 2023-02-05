import { union, z } from 'zod'
import { BuildFileContainerServiceSchema, buildFileContainerServiceSchema } from './build-file-container-service-schema'
import {
  BuildFileKubernetesServiceSchema,
  buildFileKubernetesServiceSchema,
} from './build-file-kubernetes-service-schema'
import { BuildFileTaskSchema } from './build-file-task-schema'
import { BuildFileContainerTaskSchema } from './build-file-container-task-schema'

export const buildFileServiceSchema = union([buildFileContainerServiceSchema, buildFileKubernetesServiceSchema])

export type BuildFileServiceSchema = z.infer<typeof buildFileServiceSchema>

export const isBuildFileKubernetesServiceSchema = (
  val: BuildFileServiceSchema
): val is BuildFileKubernetesServiceSchema => 'context' in val

export const isBuildFileContainerSchema = (
  val: BuildFileServiceSchema | BuildFileTaskSchema
): val is BuildFileContainerServiceSchema | BuildFileContainerTaskSchema => 'image' in val
