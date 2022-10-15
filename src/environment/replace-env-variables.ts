import { WorkNode } from '../planner/work-node'
import { StatusScopedConsole } from '../planner/work-node-status'

export function replaceEnvVariables(
  node: WorkNode,
  status: StatusScopedConsole,
  processEnv: { [key: string]: string | undefined }
): { [key: string]: string } {
  const result = { ...node.envs }
  for (const key of Object.keys(result)) {
    const value = result[key]
    if (value.startsWith('$')) {
      const processEnvValue = processEnv[value.substr(1)]
      if (processEnvValue) {
        status.write('debug', `use process env ${value.substr(1)}`)
        result[key] = processEnvValue
      } else {
        throw new Error(`missing env ${value}`)
      }
    }
  }
  return result
}
