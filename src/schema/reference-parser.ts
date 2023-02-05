import { ParseContext, ParseScope } from './parse-context'
import { BuildFileSchema } from './build-file-schema'
import { BuildFileTaskSchema, isBuildFileContainerTaskSchema } from './build-file-task-schema'
import {
  BuildFileServiceSchema,
  isBuildFileContainerSchema,
  isBuildFileKubernetesServiceSchema,
} from './build-file-service-schema'
import { splitName } from '../planner/utils/split-name'
import { readEnvFile } from '../parser/read-env-file'
import { Environment } from '../executer/environment'
import { LabelValues, mergeLabels } from '../executer/label-values'
import { mergeEnvironmentVariables } from '../environment/merge-environment-variables'

export interface ReferencedContext {
  files: { [key: string]: ReferencedFileContext }
  tasks: { [key: string]: ReferenceTask }
  services: { [key: string]: ReferenceService }
  envFiles: { [key: string]: { [key: string]: string } }
}

export interface ReferencedFileContext {
  schema: BuildFileSchema
  tasks: { [key: string]: ReferenceTask }
  services: { [key: string]: ReferenceService }
}

export interface ReferenceTask {
  type: 'task'
  scope: ParseScope
  schema: BuildFileTaskSchema
  deps: ReferenceTaskLink[]
  needs: ReferenceServiceLink[]
  relativeName: string
  envs: { [key: string]: string }
  cwd: string
  labels: LabelValues
}

export type ReferenceLinkType = 'include' | 'reference' | 'build-file'

export interface ReferenceTaskLink {
  task: ReferenceTask
  cwd: string
  relativeName: string
  type: ReferenceLinkType
}

export interface ReferenceServiceLink {
  service: ReferenceService
  relativeName: string
}

export interface ReferenceService {
  type: 'service'
  scope: ParseScope
  schema: BuildFileServiceSchema
  deps: ReferenceTaskLink[]
  needs: ReferenceServiceLink[]
  cwd: string
  relativeName: string
  envs: { [key: string]: string }
  labels: LabelValues
}

function combinePath(namePrefix: string, name: string): string {
  return namePrefix.length > 0 ? `${namePrefix}:${name}` : name
}

export async function parseReferences(ctx: ParseContext, environment: Environment): Promise<ReferencedContext> {
  const reference: ReferencedContext = {
    files: {},
    tasks: {},
    services: {},
    envFiles: {},
  }

  for (const file of Object.values(ctx.files)) {
    if (!reference.envFiles[file.cwd]) {
      reference.envFiles[file.cwd] = await readEnvFile(file.cwd, environment)
    }

    const buildFileEnvs = mergeEnvironmentVariables(file.schema.envs, reference.envFiles[file.cwd])

    if (file.schema.tasks) {
      for (const [taskName, task] of Object.entries(file.schema.tasks)) {
        const taskEnvs = mergeEnvironmentVariables(task.envs, buildFileEnvs)

        const relativeName = combinePath(file.namePrefix, taskName)
        reference.tasks[relativeName] = {
          type: 'task',
          schema: task,
          cwd: file.cwd,
          relativeName,
          labels: mergeLabels(file.schema.labels, task.labels),
          envs: taskEnvs,
          scope: file,
          needs: [],
          deps: [],
        }
      }
    }
    if (file.schema.services) {
      for (const [serviceName, service] of Object.entries(file.schema.services)) {
        const relativeName = combinePath(file.namePrefix, serviceName)
        const serviceEnvs = mergeEnvironmentVariables(
          isBuildFileKubernetesServiceSchema(service) ? {} : service.envs,
          buildFileEnvs
        )
        reference.services[relativeName] = {
          type: 'service',
          schema: service,
          cwd: file.cwd,
          relativeName,
          labels: mergeLabels(file.schema.labels, service.labels),
          scope: file,
          needs: [],
          deps: [],
          envs: serviceEnvs,
        }
      }
    }
  }

  for (const task of Object.values(reference.tasks)) {
    applySchemaExtension(reference, task)
    resolveDeps(reference, task, task.scope, task.schema)
    resolveNeeds(reference, task, task.scope, task.schema)
  }

  for (const service of Object.values(reference.services)) {
    resolveDeps(reference, service, service.scope, service.schema)
    resolveNeeds(reference, service, service.scope, service.schema)
  }

  return reference
}

function applySchemaExtension(reference: ReferencedContext, task: ReferenceTask) {
  if (!task.schema.extend) {
    return
  }

  const extend = findTask(reference, task.scope, task.schema.extend, null).task
  applySchemaExtension(reference, extend)

  applyIfNotSet(task.schema, extend.schema, ['src', 'generates', 'labels', 'cmds', 'cache', 'envs', 'shell'])
  if (isBuildFileContainerTaskSchema(extend.schema)) {
    applyIfNotSet(task.schema, extend.schema, ['image', 'mounts', 'volumes'])
  }

  resolveNeeds(reference, task, extend.scope, extend.schema)
  resolveDeps(reference, task, extend.scope, extend.schema)
}

function applyIfNotSet<T>(base: Partial<T>, extend: T, keys: (keyof T)[]) {
  for (const key of keys) {
    if (extend[key] && !base[key]) {
      base[key] = extend[key]
    }
  }
}

function resolveDeps(
  reference: ReferencedContext,
  taskOrService: ReferenceTask | ReferenceService,
  scope: ParseScope,
  schema: BuildFileTaskSchema | BuildFileServiceSchema
) {
  for (const depName of schema.deps || []) {
    const depTask = findTask(reference, scope, depName, null)
    taskOrService.deps.push({
      task: depTask.task,
      type: depTask.type,
      cwd: depTask.type === 'include' ? taskOrService.cwd : depTask.task.cwd,
      relativeName: depName,
    })
  }
}

function resolveNeeds(
  reference: ReferencedContext,
  taskOrService: ReferenceTask | ReferenceService,
  scope: ParseScope,
  schema: BuildFileTaskSchema | BuildFileServiceSchema
) {
  if (!isBuildFileContainerSchema(schema)) {
    return
  }

  for (const needName of schema.needs || []) {
    if (typeof needName === 'string') {
      taskOrService.needs.push({
        relativeName: needName,
        service: findService(reference, scope, needName),
      })
    } else {
      taskOrService.needs.push({
        relativeName: needName.name,
        service: findService(reference, scope, needName.service),
      })
    }
  }
}

export function findTask(
  ctx: ReferencedContext,
  scope: ParseScope,
  name: string,
  type: ReferenceLinkType | null
): { task: ReferenceTask; type: ReferenceLinkType } {
  const ref = splitName(name)
  if (ref.prefix) {
    if (scope.references[ref.prefix]) {
      return findTask(ctx, scope.references[ref.prefix].scope, ref.name, scope.references[ref.prefix].type)
    } else if (scope.schema.tasks && scope.schema.tasks[name]) {
      return resolveTask(ctx, scope, name, type ?? 'build-file')
    }
  } else if (scope.schema.tasks && scope.schema.tasks[ref.name]) {
    return resolveTask(ctx, scope, ref.name, type ?? 'build-file')
  }

  throw new Error('unable to find ' + name) // TODO improve
}

function resolveTask(
  ctx: ReferencedContext,
  scope: ParseScope,
  name: string,
  type: ReferenceLinkType
): { task: ReferenceTask; type: ReferenceLinkType } {
  const fullName = combinePath(scope.namePrefix, name)
  const buildFileTask = ctx.tasks[fullName]
  if (!buildFileTask) {
    throw new Error('unable to find ' + fullName)
  }
  return { task: buildFileTask, type }
}

export function findService(ctx: ReferencedContext, scope: ParseScope, name: string): ReferenceService {
  const ref = splitName(name)
  if (ref.prefix) {
    if (scope.references[ref.prefix]) {
      return findService(ctx, scope.references[ref.prefix].scope, ref.name)
    } else if (scope.schema.services && scope.schema.services[name]) {
      return resolveService(ctx, scope, name)
    }
  } else if (scope.schema.services && scope.schema.services[ref.name]) {
    return resolveService(ctx, scope, name)
  }

  throw new Error('unable to find ' + name) // TODO improve
}

function resolveService(ctx: ReferencedContext, scope: ParseScope, name: string): ReferenceService {
  const fullName = combinePath(scope.namePrefix, name)
  const service = ctx.services[fullName]
  if (!service) {
    throw new Error('unable to find ' + fullName)
  }
  return service
}
