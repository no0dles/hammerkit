import { ParseContext, ParseScope } from './parse-context'
import { BuildFileSchema } from './build-file-schema'
import { BuildFileTaskSchema, isBuildFileContainerTaskSchema } from './build-file-task-schema'
import { BuildFileServiceSchema, isBuildFileKubernetesServiceSchema } from './build-file-service-schema'
import { splitName } from '../planner/utils/split-name'
import { readEnvFile } from '../parser/read-env-file'
import { Environment } from '../executer/environment'
import { LabelValues, mergeLabels } from '../executer/label-values'
import { mergeEnvironmentVariables } from '../environment/merge-environment-variables'
import { BuildFileEnvironmentSchema } from './build-file-environment-schema'
import { BuildFileContainerTaskSchema } from './build-file-container-task-schema'
import { BuildFileCacheSchema } from './cache-schema'
import { CacheCatalog, withBuiltinCaches } from '../cache/resolve-cache'
import { findProjectRoot } from '../planner/project-root'
import {
  collectSecretCatalog,
  emptySecretCatalog,
  HostSecretDeclarations,
  SecretCatalog,
} from '../secrets/secret-catalog'
import { getHostConfigPath, readHostConfig } from '../remote/host-config'

export interface ReferencedContext {
  files: { [key: string]: ReferencedFileContext }
  tasks: { [key: string]: ReferenceTask }
  services: { [key: string]: ReferenceService }
  environments: { [key: string]: ReferenceEnvironment }
  envFiles: { [key: string]: { [key: string]: string } }
  caches: CacheCatalog
  secrets: SecretCatalog
  // anchor for machine-independent cache identity, see findProjectRoot
  projectRoot: string
  // on a server: the tasks and services left out of what is published, and why
  unpublished?: { [name: string]: string }
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
  // `extend` is applied once per task, the bases it came from nearest last
  extension?: 'applying' | 'applied'
  depBases?: { scope: ParseScope; schema: BuildFileTaskSchema }[]
  needBases?: { scope: ParseScope; schema: BuildFileTaskSchema }[]
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
  init: ReferenceTaskLink | null
  cwd: string
  relativeName: string
  envs: { [key: string]: string }
  labels: LabelValues
}

export interface ReferenceEnvironment {
  type: 'environment'
  scope: ParseScope
  name: string
  schema: BuildFileEnvironmentSchema
}

// The providers and accounts of the host config, see HostSecretDeclarations
async function readHostSecrets(environment: Environment): Promise<HostSecretDeclarations> {
  const config = await readHostConfig(environment)
  return {
    fileName: getHostConfigPath(environment),
    secretProviders: config.secretProviders,
    secretAccounts: config.secretAccounts,
  }
}

// What a task or service names that a server left out (`publish: false`)
class UnpublishedError extends Error {
  constructor(
    readonly name: string,
    readonly reason: string
  ) {
    super(`${name} is not published (${reason})`)
  }
}

// The task or service `user` names another one by, which a server left out: the error says
// which published one still needs it, as an error elsewhere is left as it is
function findPublished<T>(user: string, verb: string, find: () => T): T {
  try {
    return find()
  } catch (e) {
    if (e instanceof UnpublishedError) {
      throw new Error(`${user} ${verb} ${e.name}, which is not published (${e.reason})`)
    }
    throw e
  }
}

// The build files a server publishes: the entry file and what it includes or references,
// except through an include with `publish: false`. The key of each is in ctx.files.
function getPublishedFiles(mainScope: ParseScope): Set<ParseScope> {
  const published = new Set<ParseScope>([mainScope])
  const queue = [mainScope]
  for (let scope = queue.shift(); scope; scope = queue.shift()) {
    for (const reference of Object.values(scope.references)) {
      if (reference.publish && !published.has(reference.scope)) {
        published.add(reference.scope)
        queue.push(reference.scope)
      }
    }
  }
  return published
}

function combinePath(namePrefix: string, name: string): string {
  return namePrefix.length > 0 ? `${namePrefix}:${name}` : name
}

export async function parseReferences(
  ctx: ParseContext,
  mainScope: ParseScope,
  environment: Environment
): Promise<ReferencedContext> {
  const declaredCaches: { [name: string]: BuildFileCacheSchema } = {}
  const reference: ReferencedContext = {
    files: {},
    tasks: {},
    services: {},
    envFiles: {},
    environments: {},
    caches: {},
    secrets: emptySecretCatalog(),
    projectRoot: await findProjectRoot(mainScope.cwd, environment),
    unpublished: {},
  }
  // a server leaves out what is not published: it doesn't run, and isn't checked against
  // its policy. Locally everything is there.
  const publishedFiles = environment.hosted ? getPublishedFiles(mainScope) : null
  const isLeftOut = (file: ParseScope, name: string, schema: { publish?: boolean }) => {
    if (!publishedFiles) {
      return false
    }
    if (!publishedFiles.has(file)) {
      reference.unpublished![name] = `its build file is included with publish: false`
    } else if (schema.publish === false) {
      reference.unpublished![name] = 'publish: false'
    }
    return name in reference.unpublished!
  }

  for (const file of Object.values(ctx.files)) {
    if (environment.hosted && (file.schema.secretProviders || file.schema.secretAccounts)) {
      throw new Error(
        `${file.fileName} declares secret providers or accounts, which a server defines in its own config`
      )
    }
    if (!reference.envFiles[file.cwd]) {
      // a server does not read the `.env` of a checkout: it is code of the project
      reference.envFiles[file.cwd] = environment.hosted ? {} : await readEnvFile(file.cwd, environment)
    }

    const buildFileEnvs = file.schema.envs

    if (file.schema.tasks) {
      for (const [taskName, task] of Object.entries(file.schema.tasks)) {
        const taskEnvs = mergeEnvironmentVariables(task.envs, buildFileEnvs)

        const relativeName = combinePath(file.namePrefix, taskName)
        if (isLeftOut(file, relativeName, task)) {
          continue
        }
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

    if (file.schema.environments) {
      for (const [envName, env] of Object.entries(file.schema.environments)) {
        reference.environments[envName] = {
          type: 'environment',
          schema: env,
          scope: file,
          name: envName,
        }
      }
    }

    if (file.schema.caches) {
      for (const [cacheName, cache] of Object.entries(file.schema.caches)) {
        declaredCaches[cacheName] = cache
      }
    }

    if (file.schema.services) {
      for (const [serviceName, service] of Object.entries(file.schema.services)) {
        const relativeName = combinePath(file.namePrefix, serviceName)
        if (isLeftOut(file, relativeName, service)) {
          continue
        }
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
          init: null,
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
    resolveInit(reference, service)
  }

  reference.caches = withBuiltinCaches(declaredCaches)
  reference.secrets = environment.hosted
    ? { ...environment.hosted.catalog, explicitAccounts: true }
    : collectSecretCatalog(Object.values(ctx.files), environment, reference, await readHostSecrets(environment))

  return reference
}

function applySchemaExtension(reference: ReferencedContext, task: ReferenceTask) {
  // a base is reached once per task extending it; applying it again would add
  // its own base's lists a second time
  if (task.extension === 'applied') {
    return
  }
  if (task.extension === 'applying') {
    throw new Error(`task ${task.relativeName} extends itself`)
  }
  task.extension = 'applying'
  task.depBases = []
  task.needBases = []
  const reset = new Set<string>(task.schema.reset ?? [])
  if (!task.schema.extend) {
    if (reset.size > 0) {
      throw new Error(`task ${task.relativeName} sets reset without extend`)
    }
    task.extension = 'applied'
    return
  }

  const name = task.schema.extend
  const extend = findPublished(task.relativeName, 'extends', () => findTask(reference, task.scope, name, null)).task
  applySchemaExtension(reference, extend)

  task.schema.shell = task.schema.shell ?? extend.schema.shell
  task.schema.cache = task.schema.cache ?? extend.schema.cache
  task.schema.timeout = task.schema.timeout ?? extend.schema.timeout
  task.schema.runner = task.schema.runner ?? extend.schema.runner
  task.schema.network = task.schema.network ?? extend.schema.network
  task.schema.args = task.schema.args ?? extend.schema.args

  if (!reset.has('cmds')) task.schema.cmds = extendArray(task.schema.cmds, extend.schema.cmds)
  if (!reset.has('src')) task.schema.src = extendArray(task.schema.src, extend.schema.src)
  if (!reset.has('generates')) task.schema.generates = extendArray(task.schema.generates, extend.schema.generates)

  if (!reset.has('labels')) task.schema.labels = extendObject(task.schema.labels, extend.schema.labels)
  // the base's resolved envs: its own plus the top-level envs of its build file
  // (and the inputs an include passed), which carry the defaults it relies on
  if (!reset.has('envs')) task.envs = mergeEnvironmentVariables(task.envs, extend.envs)

  if (isBuildFileContainerTaskSchema(extend.schema)) {
    const taskSchema = task.schema as BuildFileContainerTaskSchema
    taskSchema.image = taskSchema.image ?? extend.schema.image
    if (!reset.has('mounts')) taskSchema.mounts = extendArray(taskSchema.mounts, extend.schema.mounts)
  }

  // deps and needs resolve in the file that declares them, so every base up the
  // chain contributes its own, not only the nearest; what a task resets is not
  // passed on to the tasks extending it either
  const base = { scope: extend.scope, schema: extend.schema }
  task.needBases = reset.has('needs') ? [] : [...(extend.needBases ?? []), base]
  task.depBases = reset.has('deps') ? [] : [...(extend.depBases ?? []), base]
  for (const needBase of task.needBases) {
    resolveNeeds(reference, task, needBase.scope, needBase.schema)
  }
  for (const depBase of task.depBases) {
    resolveDeps(reference, task, depBase.scope, depBase.schema)
  }
  task.extension = 'applied'
}

function extendArray<T>(base: T[] | undefined, extend: T[] | undefined): T[] | undefined {
  if (!extend) {
    return base
  }

  if (!base) {
    return [...extend]
  }

  return [...extend, ...base]
}

function extendObject<T>(
  base: { [key: string]: T } | undefined,
  extend: { [key: string]: T } | undefined
): { [key: string]: T } | undefined {
  if (!extend) {
    return base
  }

  if (!base) {
    return { ...extend }
  }

  return { ...extend, ...base }
}

function resolveDeps(
  reference: ReferencedContext,
  taskOrService: ReferenceTask | ReferenceService,
  scope: ParseScope,
  schema: BuildFileTaskSchema | BuildFileServiceSchema
) {
  for (const depName of schema.deps || []) {
    const depTask = findPublished(taskOrService.relativeName, 'depends on', () =>
      findTask(reference, scope, depName, null)
    )
    taskOrService.deps.push({
      task: depTask.task,
      type: depTask.type,
      cwd: depTask.type === 'include' ? taskOrService.cwd : depTask.task.cwd,
      relativeName: depName,
    })
  }
}

function resolveInit(reference: ReferencedContext, service: ReferenceService) {
  if (isBuildFileKubernetesServiceSchema(service.schema) || !service.schema.init) {
    return
  }
  const init = service.schema.init
  const initTask = findPublished(service.relativeName, 'runs as init', () =>
    findTask(reference, service.scope, init, null)
  )
  service.init = {
    task: initTask.task,
    type: initTask.type,
    cwd: initTask.type === 'include' ? service.cwd : initTask.task.cwd,
    relativeName: service.schema.init,
  }
}

function resolveNeeds(
  reference: ReferencedContext,
  taskOrService: ReferenceTask | ReferenceService,
  scope: ParseScope,
  schema: BuildFileTaskSchema | BuildFileServiceSchema
) {
  if (isBuildFileKubernetesServiceSchema(schema)) {
    return
  }

  for (const needName of schema.needs || []) {
    if (typeof needName === 'string') {
      taskOrService.needs.push({
        // the host name it is reached by: a service of an include, `services:postgres`, as
        // `services-postgres`, since Docker and DNS take no colon
        relativeName: needName.replace(/:/g, '-'),
        service: findPublished(taskOrService.relativeName, 'needs', () => findService(reference, scope, needName)),
      })
    } else {
      taskOrService.needs.push({
        relativeName: needName.name,
        service: findPublished(taskOrService.relativeName, 'needs', () =>
          findService(reference, scope, needName.service)
        ),
      })
    }
  }
  const names = taskOrService.needs.map((need) => need.relativeName)
  const twice = names.find((name, index) => names.indexOf(name) !== index)
  if (twice) {
    throw new Error(`${taskOrService.relativeName} needs two services as ${twice}, give one another name with name:`)
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
  if (!buildFileTask && ctx.unpublished?.[fullName]) {
    throw new UnpublishedError(fullName, ctx.unpublished[fullName])
  }
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
  if (!service && ctx.unpublished?.[fullName]) {
    throw new UnpublishedError(fullName, ctx.unpublished[fullName])
  }
  if (!service) {
    throw new Error('unable to find ' + fullName)
  }
  return service
}
