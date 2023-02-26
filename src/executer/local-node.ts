import { Environment } from './environment'
import { AbortError, checkForAbort } from './abort'
import { executeCommand } from './execute-command'
import { getErrorMessage } from '../log'
import { WorkItemState } from '../planner/work-item'
import { LocalWorkNode } from '../planner/work-node'
import { NodeState } from './scheduler/node-state'
import { getEnvironmentVariables } from '../environment/replace-env-variables'

export async function localNode(
  item: WorkItemState<LocalWorkNode, NodeState>,
  stateKey: string,
  environment: Environment,
  abort: AbortSignal
): Promise<void> {
  item.status.write('info', `execute ${item.name} locally`)

  const envs = getEnvironmentVariables(item.data.envs)
  try {
    for (const cmd of item.data.cmds) {
      checkForAbort(abort)

      item.status.write('info', `execute cmd "${cmd.cmd}" locally`)

      const exitCode = await executeCommand(item.status, abort, cmd.cwd, cmd.cmd, envs, environment)
      if (exitCode !== 0) {
        item.state.set({
          type: 'crash',
          exitCode,
          stateKey,
        })
        return
      }
    }
  } catch (e) {
    if (e instanceof AbortError) {
      item.state.set({
        type: 'canceled',
        stateKey,
      })
    } else {
      item.state.set({
        type: 'error',
        stateKey,
        errorMessage: getErrorMessage(e),
      })
    }
  }
}
