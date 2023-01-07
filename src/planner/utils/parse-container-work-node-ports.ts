import { WorkContext } from '../work-context'
import { WorkPort } from '../work-port'
import { templateValue } from './template-value'
import { parseWorkPort } from './parse-work-port'
import { PlannedTask } from './planned-task'

export function parseContainerWorkNodePorts(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkPort[] {
  return task.ports.map((m) => templateValue(m, envs)).map((m) => parseWorkPort(m))
}
