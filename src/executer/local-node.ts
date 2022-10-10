import { WorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { Process } from './emitter'
import { HammerkitEvent, NodeCanceledEvent, NodeCompletedEvent, NodeCrashEvent, NodeErrorEvent } from './events'
import { getProcessEnvs } from '../environment/get-process-env'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { AbortError, checkForAbort } from './abort'
import { templateValue } from '../planner/utils/template-value'
import { executeCommand } from './execute-command'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { getErrorMessage } from '../log'

export function localNode(
  node: WorkNode,
  environment: Environment
): Process<NodeCanceledEvent | NodeErrorEvent | NodeCrashEvent | NodeCompletedEvent, HammerkitEvent> {
  return async (abort, emitter) => {
    node.status.write('info', `execute ${node.name} locally`)

    try {
      const envs = getProcessEnvs(replaceEnvVariables(node, environment.processEnvs), environment)
      for (const cmd of node.cmds) {
        checkForAbort(abort)

        const command = templateValue(cmd.cmd, envs)
        node.status.write('info', `execute cmd "${command}" locally`)

        const exitCode = await executeCommand(node, emitter, abort, cmd.path, command, envs)
        if (exitCode !== 0) {
          return {
            type: 'node-crash',
            node: node,
            exitCode,
            command,
          }
        }
      }

      await writeWorkNodeCache(node, environment)

      return {
        type: 'node-completed',
        node: node,
      }
    } catch (e) {
      if (e instanceof AbortError) {
        return {
          type: 'node-canceled',
          node,
        }
      } else {
        return {
          type: 'node-error',
          node,
          errorMessage: getErrorMessage(e),
        }
      }
    }
  }
}
