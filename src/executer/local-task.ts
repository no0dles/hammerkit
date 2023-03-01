import { Environment } from './environment'
import { AbortError, checkForAbort } from './abort'
import { executeCommand } from './execute-command'
import { getErrorMessage } from '../log'
import { WorkItem } from '../planner/work-item'
import { LocalWorkTask } from '../planner/work-task'
import { TaskState } from './scheduler/task-state'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { ExecuteOptions } from '../runtime/runtime'

export async function localTask(
  item: WorkItem<LocalWorkTask>,
  environment: Environment,
  options: ExecuteOptions<TaskState>
): Promise<void> {
  item.status.write('info', `execute ${item.name} locally`)

  const envs = getEnvironmentVariables(item.data.envs)
  try {
    for (const cmd of item.data.cmds) {
      checkForAbort(options.abort)

      item.status.write('info', `execute cmd "${cmd.cmd}" locally`)

      const exitCode = await executeCommand(item.status, options.abort, cmd.cwd, cmd.cmd, envs, environment)
      if (exitCode !== 0) {
        options.state.set({
          type: 'crash',
          exitCode,
          stateKey: options.stateKey,
        })
        return
      }
    }
  } catch (e) {
    if (e instanceof AbortError) {
      options.state.set({
        type: 'canceled',
        stateKey: options.stateKey,
      })
    } else {
      options.state.set({
        type: 'error',
        stateKey: options.stateKey,
        errorMessage: getErrorMessage(e),
      })
    }
  }
}
