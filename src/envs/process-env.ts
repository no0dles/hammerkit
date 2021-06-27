import { RunArg } from '../run-arg'

export function getProcessEnvs(envs: { [key: string]: string }, arg: RunArg) {
  const result = { ...envs }
  for (const key of Object.keys(arg.processEnvs)) {
    const value = arg.processEnvs[key]
    if (!result[key] && value) {
      result[key] = value
    }
  }
  return result
}
