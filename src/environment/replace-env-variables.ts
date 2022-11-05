import { WorkNode } from '../planner/work-node'

export function replaceEnvVariables(
  node: WorkNode,
  processEnv: { [key: string]: string | undefined }
): { [key: string]: string } {
  const result = { ...node.envs }
  for (const key of Object.keys(result)) {
    const value = result[key]
    if (value.startsWith('$')) {
      const processEnvValue = processEnv[value.substr(1)]
      if (processEnvValue) {
        result[key] = processEnvValue
      } else {
        throw new Error(`missing env ${value}`)
      }
    }
  }
  return result
}
