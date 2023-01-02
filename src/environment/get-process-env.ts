import { Environment } from '../executer/environment'

export function extendHostVariables(envs: { [key: string]: string }, ctx: Environment): { [key: string]: string } {
  const result = { ...envs }
  for (const key of ['PATH']) {
    const value = ctx.processEnvs[key]
    if (!result[key] && value) {
      result[key] = value
    }
  }
  return result
}
