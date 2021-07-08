import { isContainerWorkNode, WorkNode } from '../planner/work-node'
import { executeDocker } from './execute-docker'
import { executeLocal } from './execute-local'
import { Defer } from '../defer'
import { ExecutionContext } from '../run-arg'

export async function executeWorkNode(
  node: WorkNode,
  context: ExecutionContext,
  cancelDefer: Defer<void>
): Promise<void> {
  const envs = replaceEnvVariables(node, context.context.processEnvs)
  if (isContainerWorkNode(node) && !context.noContainer) {
    await executeDocker(
      {
        ...node,
        envs,
      },
      context,
      cancelDefer
    )
  } else {
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
  }
}

function replaceEnvVariables(
  node: WorkNode,
  processEnv: { [key: string]: string | undefined }
): { [key: string]: string } {
  const result = { ...node.envs }
  for (const key of Object.keys(result)) {
    const value = result[key]
    if (value.startsWith('$')) {
      const processEnvValue = processEnv[value.substr(1)]
      if (processEnvValue) {
        node.status.console.write('internal', 'debug', `use process env ${value.substr(1)}`)
        result[key] = processEnvValue
      } else {
        throw new Error(`missing env ${value}`)
      }
    }
  }
  return result
}
