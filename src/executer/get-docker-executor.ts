import { Executor } from './executor'
import { isContainerWorkNode, WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { executeDocker } from './execute-docker'
import { getLocalExecutor } from './get-local-executor'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { Defer } from '../utils/defer'
import { WorkTree } from '../planner/work-tree'

export function getDockerExecutor(): Executor {
  const localExec = getLocalExecutor()

  return {
    async exec(workTree: WorkTree, node: WorkNode, context: ExecutionContext, cancelDefer: Defer<void>): Promise<void> {
      if (!isContainerWorkNode(node)) {
        return localExec.exec(workTree, node, context, cancelDefer)
      }

      const envs = replaceEnvVariables(node, context.environment.processEnvs)
      await executeDocker(
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
