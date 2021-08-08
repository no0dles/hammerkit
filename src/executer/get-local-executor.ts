import { Executor } from './executor'
import { isContainerWorkNode, WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { executeLocal } from './execute-local'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { Defer } from '../utils/defer'
import { WorkTree } from '../planner/work-tree'

export function getLocalExecutor(): Executor {
  return {
    async exec(workTree: WorkTree, node: WorkNode, context: ExecutionContext, cancelDefer: Defer<void>): Promise<void> {
      const envs = replaceEnvVariables(node, context.environment.processEnvs)
      if (isContainerWorkNode(node)) {
        node.status.console.write('internal', 'debug', `${node.name} is executed locally instead inside of a container`)
      }

      await executeLocal(
        {
          ...node,
          envs,
        },
        context,
        cancelDefer
      )
    },
  }
}
