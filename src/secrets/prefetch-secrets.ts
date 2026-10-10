import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { resolveSecretValue } from '../planner/work-secret'
import { beginSecretRun } from './provider-values'

// Fetches the values a task id needs; a run drops the ones of the previous run
// first (`newRun`), any other command reuses what the run already fetched. A task id is computed synchronously and holds the
// digest of each `cache: true` secret, so those values must be in memory before
// anything asks for an id. Secrets that don't affect the id are read when their
// task starts, and a plan without provider secrets calls no provider.
export async function prefetchSecrets(workTree: WorkTree, environment: Environment, newRun = false): Promise<void> {
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
