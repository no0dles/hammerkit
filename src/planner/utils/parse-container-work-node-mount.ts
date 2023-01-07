import { WorkContext } from '../work-context'
import { WorkNodeGenerate } from '../work-node'
import { WorkMount } from '../work-mount'
import { templateValue } from './template-value'
import { parseWorkMount } from './parse-work-mount'
import { PlannedTask } from './planned-task'

export function parseContainerWorkNodeMount(
  task: PlannedTask,
  context: WorkContext,
  generates: WorkNodeGenerate[],
  envs: { [key: string]: string } | null
): WorkMount[] {
  const mounts = task.mounts.map((m) => templateValue(m, envs)).map((m) => parseWorkMount(context.cwd, m))
  const fileGenerates = generates
    .filter((g) => g.isFile)
    .map<WorkMount>((g) => ({
      localPath: g.path,
      containerPath: g.path,
    }))
  return [...mounts, ...fileGenerates]
}
