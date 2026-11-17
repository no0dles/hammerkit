import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkServices, iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { resolveSecretValue, WorkSecret } from '../planner/work-secret'
import { beginSecretRun } from './provider-values'

function secretsOf(workTree: WorkTree): WorkSecret[] {
  return [
    ...[...iterateWorkServices(workTree)].flatMap((service) => ('secrets' in service.data ? service.data.secrets : [])),
    ...[...iterateWorkTasks(workTree)].flatMap((task) => task.data.secrets),
  ]
}

// A secret of a provider that this machine does not declare fails a command only when the
// command needs it: a run needs every secret of the tasks and services it holds, the other
// commands the `cache: true` ones, for task ids. A task elsewhere in the build file that reads
// it does not stop them (ADR 0008).
export function requireReadableSecrets(workTree: WorkTree, needed: (secret: WorkSecret) => boolean = () => true): void {
  for (const secret of secretsOf(workTree)) {
    if (secret.source.type === 'unavailable' && needed(secret)) {
      throw new Error(secret.source.error)
    }
  }
}

// Fetches the values a task id needs; a run drops the ones of the previous run
// first (`newRun`), any other command reuses what the run already fetched. A task id is computed synchronously and holds the
// digest of each `cache: true` secret, so those values must be in memory before
// anything asks for an id. Secrets that don't affect the id are read when their
// task starts, and a plan without provider secrets calls no provider.
export async function prefetchSecrets(workTree: WorkTree, environment: Environment, newRun = false): Promise<void> {
  requireReadableSecrets(workTree, (secret) => secret.cache)
  if (newRun) {
    beginSecretRun(environment)
  }
  const fetches: Promise<string>[] = []
  for (const task of iterateWorkTasks(workTree)) {
    for (const secret of task.data.secrets) {
      if (secret.cache && secret.source.type === 'provider') {
        fetches.push(resolveSecretValue(secret, environment))
      }
    }
  }
  await Promise.all(fetches)
}
