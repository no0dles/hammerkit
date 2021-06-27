import { isContainerWorkNode, WorkNode } from '../planner/work-node'
import { RunArg } from '../run-arg'
import { executeDocker } from './execute-docker'
import consola from 'consola'
import { executeLocal } from './execute-local'

export async function executeWorkNode(task: WorkNode, arg: RunArg): Promise<void> {
  const envs = replaceEnvVariables(task.envs, arg.processEnvs)
  if (isContainerWorkNode(task) && !arg.noContainer) {
    await executeDocker(
      {
        ...task,
        envs,
      },
      arg
    )
  } else {
    if (isContainerWorkNode(task)) {
      consola.debug(`${task.name} is executed locally instead inside of a container`)
    }

    await executeLocal(
      {
        ...task,
        envs,
      },
      arg
    )
  }
}

function replaceEnvVariables(
  baseEnv: { [key: string]: string },
  processEnv: { [key: string]: string | undefined }
): { [key: string]: string } {
  const result = { ...baseEnv }
  for (const key of Object.keys(result)) {
    const value = result[key]
    if (value.startsWith('$')) {
      const processEnvValue = processEnv[value.substr(1)]
      if (processEnvValue) {
        consola.debug(`use process env ${value.substr(1)}`)
        result[key] = processEnvValue
      } else {
        throw new Error(`missing env ${value}`)
      }
    }
  }
  return result
}
