import { WorkContext } from '../work-context'
import { WorkNodeCommand } from '../work-node-command'
import { planWorkCommand } from './plan-work-command'
import { templateValue } from './template-value'
import { PlannedTask } from './planned-task'

export function parseWorkNodeCommand(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkNodeCommand[] {
  return planWorkCommand(
    task.cmds.map((cmd) => {
      if (typeof cmd === 'string') {
        return templateValue(cmd, envs)
      } else {
        return {
          cmd: templateValue(cmd.cmd, envs),
          path: templateValue(cmd.path, envs),
          type: cmd.type,
        }
      }
    }),
    context.cwd
  )
}
