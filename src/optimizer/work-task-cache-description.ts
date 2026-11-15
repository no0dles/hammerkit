import { platform } from 'os'
import { createHash } from 'crypto'
import { WorkTask } from '../planner/work-task'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { portablePath } from '../planner/utils/portable-path'
import { WorkItem } from '../planner/work-item'
import { describeSecretSource, getPortableSecretName, WorkSecret } from '../planner/work-secret'
import { hasOutputsFlatteningAlike, hasPathsEndingAlike } from '../kubernetes/claim-layout'
import { isContainerWorkService, WorkService } from '../planner/work-service'
import { getWorkServiceId } from '../planner/work-service-id'
import { getDeclaredWorkTaskId } from '../planner/work-cache-id'
import { getHealthcheckDefinition } from '../planner/work-healthcheck'

export interface WorkTaskCacheDescription {
  cwd?: string
  deps?: string[]
  src?: string[]
  generates?: string[]
  envs?: { [key: string]: string }
  cmds?: { cwd: string; cmd: string }[]
  image?: string | null
  mounts?: string[]
  shell?: string | null
  platform?: string
  arch?: string
  // `cache: true` secrets: name and salted digest, never the value
  secrets?: string[]
  // the other secrets: name and where the value comes from (getSecretSources), never the value:
  // which secrets a task declares is part of what it is
  secretSources?: string[]
  // 2 when two paths of the task end alike, such as `api/node_modules` and
  // `cli/node_modules`. In its claim on Kubernetes they shared one folder before
  // getClaimSubPath named them apart, so what such a task made then (its kept claims,
  // its cached outputs) is mixed: the new id leaves it behind. The same for two outputs
  // that shared one cache archive (`a-b` and `a/b`).
  claimLayout?: number
  // the services it needs, `name=<identity>` (getWorkServiceCacheIdentity): what an e2e test
  // passed against is part of what it is
  needs?: string[]
}

// Every path is made project-relative (portablePath) so the description, and the
// task id hashed from it, is identical wherever the project is checked out.
//
// `deps` holds the dependencies' task ids, so a change to a dependency's
// definition (command, env, image, …) gives every task depending on it a new id.
// The state key only folds in the dependencies' *sources*.
export function getWorkTaskCacheDescription(item: WorkItem<WorkTask>): WorkTaskCacheDescription {
  const task = item.data
  const portable = (path: string) => portablePath(task.projectRoot, path)
  const envs = getEnvironmentVariables(task.envs)
  const cachedSecrets = task.secrets
    .filter((secret) => secret.cache)
    .map((secret) => `${getPortableSecretName(task.projectRoot, secret)}=${secret.digest()}`)
    .sort()
  const secretSources = getSecretSources(task.projectRoot, task.secrets)
  return {
    shell: task.shell ?? undefined,
    platform: task.type === 'container-task' ? task.image : platform(),
    // outputs hold native binaries, and docker pulls images for the host
    // architecture, so container tasks are keyed by it too; on a cluster it is the
    // one of the nodes the task runs on
    arch: (task.type === 'container-task' && task.arch) || process.arch,
    // a file a dep generates is in its task id already (`deps`), and was left out of the
    // generates before it was handed on: ids stay as they were
    generates:
      task.generates
        .filter((g) => !(g.inherited && g.isFile))
        .map((g) => portable(g.path))
        .sort() ?? undefined,
    src: task.src.map((s) => s.source).sort() ?? undefined,
    envs:
      Object.keys(envs)
        .sort()
        .reduce<{ [key: string]: string }>((map, key) => {
          map[key] = envs[key]
          return map
        }, {}) ?? undefined,
    cmds: task.cmds.map((c) => ({ cmd: c.cmd, cwd: portable(c.cwd) })),
    mounts: task.type === 'container-task' ? task.mounts.map((m) => m.mount).sort() : undefined,
    cwd: portable(task.cwd),
    deps: item.deps.length > 0 ? item.deps.map((dep) => dep.id()).sort() : undefined,
    secrets: cachedSecrets.length > 0 ? cachedSecrets : undefined,
    secretSources: secretSources.length > 0 ? secretSources : undefined,
    claimLayout: hasPathsEndingAlike(item) || hasOutputsFlatteningAlike(item) ? 2 : undefined,
    needs: item.needs.length > 0 ? getNeedsIdentities(item) : undefined,
  }
}

// The secrets without `cache: true`, by name and source: `NAME<env:VAR`, `NAME<gcp:ref as
// account`, `NAME<file` (a path of the machine, which differs between machines). Their values
// stay out of the key, as before: what a provider returns may change on every read.
export function getSecretSources(projectRoot: string, secrets: WorkSecret[]): string[] {
  return secrets
    .filter((secret) => !secret.cache)
    .map((secret) => {
      const source = secret.source
      const from = source.type === 'file' ? 'file' : describeSecretSource(secret)
      return `${getPortableSecretName(projectRoot, secret)}<${from}`
    })
    .sort()
}

// `visiting` holds the services on the way here: services that need each other in a loop
// fail to plan (checkForLoop), the identity only has to come back to say so
function getNeedsIdentities(
  item: WorkItem<WorkTask | WorkService>,
  visiting: Set<WorkItem<WorkService>> = new Set()
): string[] {
  return (
    item.needs
      // an init task needs the service it initializes, whose identity holds the init's id
      .filter((need) => !isInitOf(item, need.service))
      .map((need) =>
        visiting.has(need.service)
          ? `${need.name}=loop`
          : `${need.name}=${getWorkServiceCacheIdentity(need.service, visiting)}`
      )
      .sort()
  )
}

function isInitOf(item: WorkItem<WorkTask | WorkService>, service: WorkItem<WorkService>): boolean {
  return isContainerWorkService(service.data) && service.data.init?.task.data === item.data
}

// Everything that makes a service what a task needing it talks to: its definition, the ids of
// the tasks it depends on and of its init task, and the services it needs in turn. The source
// of those tasks and of the service is in the state key (computeStateKey), like a dependency's.
// Not the service id, which leaves out what a service runs (getWorkServiceId).
export function getWorkServiceCacheIdentity(
  item: WorkItem<WorkService>,
  visiting: Set<WorkItem<WorkService>> = new Set()
): string {
  const service = item.data
  const definition = isContainerWorkService(service)
    ? {
        cmd: service.cmd?.cmd ?? null,
        envs: getEnvironmentVariables(service.envs),
        healthcheck: service.healthcheck ? getHealthcheckDefinition(service.healthcheck) : null,
        secrets: service.secrets
          .filter((secret) => secret.cache)
          .map((secret) => `${getPortableSecretName(service.projectRoot, secret)}=${secret.digest()}`)
          .sort(),
        // left out when it reads none, so the identity of such a service stays what it was
        ...(service.secrets.some((secret) => !secret.cache)
          ? { secretSources: getSecretSources(service.projectRoot, service.secrets) }
          : {}),
        // as declared: arguments after -- of a run of the init leave the service as it is
        init: service.init ? getDeclaredWorkTaskId(service.init.task) : null,
      }
    : { namespace: service.namespace }
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: getWorkServiceId(service),
        ...definition,
        ports: service.ports.map((port) => `${port.hostPort ?? ''}:${port.containerPort}`).sort(),
        deps: item.deps.map((dep) => dep.id()).sort(),
        needs: getNeedsIdentities(item, new Set([...visiting, item])),
      })
    )
    .digest('hex')
}

// The form written to disk: description.json in a cache entry (pushed to remote
// backends, readable by everyone who can pull) and the local explain record.
// Env is where tokens get passed, so each value is stored as a digest; the task
// id is still hashed from the values themselves. So are where its secrets come from: who may
// pull an entry need not know which secrets of which provider a task reads.
export function storedCacheDescription(description: WorkTaskCacheDescription): WorkTaskCacheDescription {
  if (!description.envs && !description.secretSources) {
    return description
  }
  const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
  const stored: WorkTaskCacheDescription = { ...description }
  if (description.envs) {
    const envs: { [key: string]: string } = {}
    for (const [key, value] of Object.entries(description.envs)) {
      envs[key] = digest(value)
    }
    stored.envs = envs
  }
  if (description.secretSources) {
    stored.secretSources = description.secretSources.map(digest)
  }
  return stored
}
