import { WorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { getProcessEnvs } from '../environment/get-process-env'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { AbortError, checkForAbort } from './abort'
import { templateValue } from '../planner/utils/template-value'
import { executeCommand } from './execute-command'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { getErrorMessage } from '../log'
import { getDuration } from './states'
import { State } from './state'
import { Process } from './process'
import { startNode } from './start-node'

export function localNode(node: WorkNode, state: State, environment: Environment): Process {
  return async (abort, started) => {
    const status = environment.status.task(node)
    status.write('info', `execute ${node.name} locally`)

    if (await startNode(node, started, state, abort, environment)) {
      return
    }

    try {
      const envs = getProcessEnvs(replaceEnvVariables(node, status, environment.processEnvs), environment)
      for (const cmd of node.cmds) {
        checkForAbort(abort.signal)

        const command = templateValue(cmd.cmd, envs)
        status.write('info', `execute cmd "${command}" locally`)

        const exitCode = await executeCommand(status, abort.signal, cmd.path, command, envs)
        if (exitCode !== 0) {
          state.patchNode({
            type: 'crash',
            node,
            exitCode,
          })
          return
        }
      }

      await writeWorkNodeCache(node, state.current.cacheMethod, environment)

      state.patchNode({
        type: 'completed',
        node: node,
        cached: false,
        duration: getDuration(started),
      })
    } catch (e) {
      if (e instanceof AbortError) {
        state.patchNode({
          type: 'canceled',
          node,
        })
      } else {
        state.patchNode({
          type: 'error',
          node,
          errorMessage: getErrorMessage(e),
        })
      }
    }
  }
}
