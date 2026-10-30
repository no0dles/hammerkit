import { WorkService } from '../planner/work-service'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { getRunLabels, getRunLabelValue } from './job-placement'

// An object name is a DNS label: lowercase letters, digits and `-`, at most 63
// characters, starting and ending with a letter or digit. The id makes a name
// unique; the item's name is there for people and is cut to fit.
const MAX_NAME = 63

export const ID_LABEL = 'hammerkit.dev/id'

type Scope = Pick<WorkKubernetesEnvironment, 'server'>

// What tells the objects of an item apart in its namespace: its id, and on a server the
// run's label too. The runs of a caller execute side by side in their namespace, and two
// of them often run the same task (the same command on two sandboxes of a repository),
// so each has objects of its own, which nothing of the other run finds or removes. The
// first 8 digits of the run label tell runs apart, as they do for a run's proxies.
export function getItemKey(item: WorkItem<WorkService | WorkTask>, env: Scope): string {
  return env.server ? `${item.id().substring(0, 32)}-${getRunLabelValue(env.server.run).substring(0, 8)}` : item.id()
}

// The labels the objects of an item carry, by which they are found again
export function getItemLabels(item: WorkItem<WorkService | WorkTask>, env: Scope): { [label: string]: string } {
  return { [ID_LABEL]: item.id(), ...getRunLabels(env) }
}

export function getItemSelector(item: WorkItem<WorkService | WorkTask>, env: Scope): string {
  return Object.entries(getItemLabels(item, env))
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
}

export function getResourceName(item: WorkItem<WorkService | WorkTask>, env: Scope, suffix?: string) {
  const tail = `-${getItemKey(item, env)}${suffix ?? ''}`
  const name = removeInvalidCharacters(item.name)
    .slice(0, Math.max(0, MAX_NAME - tail.length))
    .replace(/-+$/, '')
  return name ? name + tail : tail.slice(1)
}

export function removeInvalidCharacters(val: string) {
  return val
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
}
