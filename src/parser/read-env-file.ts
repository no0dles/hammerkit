import { basename, join } from 'path'
import { Environment } from '../executer/environment'

export async function readEnvFile(
  path: string,
  baseEnv: { [key: string]: string },
  environment: Environment
): Promise<{ [key: string]: string }> {
  const directory = join(path, '.env')

  let envs: { [key: string]: string } = { ...baseEnv }

  if (basename(path) !== path) {
    envs = { ...(await readEnvFile(basename(path), envs, environment)) }
  }

  const exists = await environment.file.exists(directory)
  if (!exists) {
    return envs
  }

  const envFile = (await environment.file.read(directory)).split(/\r?\n/)
  for (const envVar of envFile) {
    const index = envVar.indexOf('=')
    if (index > 0) {
      const key = envVar.substr(0, index)
      const value = envVar.substr(index + 1)
      if (!envs[key]) {
        environment.console.debug(`load env variable ${key} from ${directory} file`)
        envs[key] = value
      }
    }
  }

  return envs
}
