import { WorkContext } from '../work-context'
import { WorkNodeSource } from '../work-node-source'
import { templateValue } from './template-value'
import { mapSource } from './map-source'
import { PlannedTask } from './planned-task'

export function parseLocalWorkNodeSource(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkNodeSource[] {
  return task.src
    .map((src) => ({
      relativePath: templateValue(src.relativePath, envs),
      matcher: src.matcher,
    }))
    .map((src) => mapSource(src, context.cwd))
}
