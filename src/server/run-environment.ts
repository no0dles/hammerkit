import { ServerConfig } from './server-config'

// What a run sees of the server's environment: the variables the operator listed
// in `runs.env.allow`, and the fixed ones of `runs.env.set`. The credentials of a
// run are not among them, they exist only as the secrets of an account.
export function runEnvironment(
  config: ServerConfig,
  processEnvs: { [key: string]: string | undefined }
): { [key: string]: string | undefined } {
  const passed: { [key: string]: string | undefined } = {}
  for (const name of config.runs.env.allow) {
    // Windows names are not case sensitive
    const windows = process.platform === 'win32'
    const key = Object.keys(processEnvs).find((k) => k === name || (windows && k.toLowerCase() === name.toLowerCase()))
    if (key !== undefined && processEnvs[key] !== undefined) {
      passed[name] = processEnvs[key]
    }
  }
  return { ...passed, ...config.runs.env.set }
}
