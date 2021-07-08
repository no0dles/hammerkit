import { Context } from '../run-arg'

export function getProcessEnvs(envs: { [key: string]: string }, ctx: Context): { [key: string]: string } {
  const result = { ...envs }
  for (const key of Object.keys(ctx.processEnvs)) {
    const value = ctx.processEnvs[key]
    if (!result[key] && value) {
      result[key] = value
    }
  }
  return result
}
