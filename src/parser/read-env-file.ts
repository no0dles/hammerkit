import { basename, join } from 'path'
import { Environment } from '../executer/environment'

export async function readEnvFile(
  path: string,
  environment: Environment,
  baseEnv: { [key: string]: string } = {}
): Promise<{ [key: string]: string }> {
  const directory = join(path, '.env')

  let envs: { [key: string]: string } = { ...baseEnv }

  if (basename(path) !== path) {
    envs = { ...(await readEnvFile(basename(path), environment, envs)) }
  }

  const exists = await environment.file.exists(directory)
  if (!exists) {
    return envs
  }

  const envFile = (await environment.file.read(directory)).split(/\r?\n/)
  for (const envVar of envFile) {
    const index = envVar.indexOf('=')
    if (index > 0) {
      const key = envVar.substring(0, index)
      const value = envVar.substring(index + 1)
      if (!envs[key]) {
        envs[key] = value
      }
    }
  }

  return envs
}
