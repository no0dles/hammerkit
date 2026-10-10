import { createHash } from 'crypto'
import { WorkItem } from './work-item'
import { WorkService } from './work-service'
import { WorkTask } from './work-task'

// `id()` is the portable cache identity: identical for the same task in every
// checkout, so a shared cache hits across machines. Machine-local runtime state
// (docker container labels, task state files, the cache staging directory)
// must instead stay scoped to one checkout — two worktrees of the same repo on
// one host would otherwise see each other's state records and staging files. The instance
// id folds the absolute project root into the portable id for that purpose.
export function getWorkInstanceId(item: WorkItem<WorkTask | WorkService>): string {
  return createHash('sha1').update(`${item.id()}\0${item.data.projectRoot}`).digest('hex')
}
