import { WorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { AbortError, checkForAbort } from './abort'
import { executeCommand } from './execute-command'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { getErrorMessage } from '../log'
import { getDuration } from './states'
import { State } from './state'
import { Process } from './process'

export function localNode(node: WorkNode, stateKey: string, state: State, environment: Environment): Process {
  return async (abort, started) => {
    const status = environment.status.task(node)
    status.write('info', `execute ${node.name} locally`)

    try {
      for (const cmd of node.cmds) {
        checkForAbort(abort.signal)

        status.write('info', `execute cmd "${cmd.cmd}" locally`)

        const exitCode = await executeCommand(status, abort.signal, cmd.path, cmd.cmd, node.envs)
        if (exitCode !== 0) {
          state.patchNode(
            {
              type: 'crash',
              node,
              exitCode,
              stateKey,
            },
            stateKey
          )
          return
        }
      }

      await writeWorkNodeCache(node, environment)

      state.patchNode(
        {
          type: 'completed',
          node: node,
          cached: false,
          stateKey,
          duration: getDuration(started),
        },
        stateKey
      )
    } catch (e) {
      if (e instanceof AbortError) {
        state.patchNode(
          {
            type: 'canceled',
            node,
            stateKey,
          },
          stateKey
        )
      } else {
        state.patchNode(
          {
            type: 'error',
            node,
            stateKey,
            errorMessage: getErrorMessage(e),
          },
          stateKey
        )
      }
    }
  }
}
