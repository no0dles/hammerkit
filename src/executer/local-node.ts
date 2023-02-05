import { Environment } from './environment'
import { AbortError, checkForAbort } from './abort'
import { executeCommand } from './execute-command'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { getErrorMessage } from '../log'
import { getDuration } from './states'
import { State } from './state'
import { Process } from './process'
import { WorkItem } from '../planner/work-item'
import { LocalWorkNode } from '../planner/work-node'

export function localNode(
  item: WorkItem<LocalWorkNode>,
  stateKey: string,
  state: State,
  environment: Environment
): Process {
  return async (abort, started) => {
    item.status.write('info', `execute ${item.name} locally`)

    try {
      for (const cmd of item.data.cmds) {
        checkForAbort(abort.signal)

        item.status.write('info', `execute cmd "${cmd.cmd}" locally`)

        const exitCode = await executeCommand(item.status, abort.signal, cmd.cwd, cmd.cmd, item.data.envs, environment)
        if (exitCode !== 0) {
          state.patchNode(
            {
              type: 'crash',
              node: item,
              itemId: item.id,
              exitCode,
              stateKey,
            },
            stateKey
          )
          return
        }
      }

      await writeWorkNodeCache(item, environment)

      state.patchNode(
        {
          type: 'completed',
          node: item,
          itemId: item.id,
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
            node: item,
            itemId: item.id,
            stateKey,
          },
          stateKey
        )
      } else {
        state.patchNode(
          {
            type: 'error',
            node: item,
            itemId: item.id,
            stateKey,
            errorMessage: getErrorMessage(e),
          },
          stateKey
        )
      }
    }
  }
}
