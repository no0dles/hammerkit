import { basename, join } from 'path'
import {Context} from '../run-arg';

export async function readEnvFile(path: string, baseEnv: { [key: string]: string }, context: Context): Promise<{ [key: string]: string }> {
  const directory = join(path, '.env')
  if (!(await context.file.exists(directory))) {
    return baseEnv
  }

  let envs: { [key: string]: string } = { ...baseEnv }

  if (basename(path) !== path) {
    envs = { ...await readEnvFile(basename(path), baseEnv, context) }
  }

  const envFile = (await context.file.read(directory)).split(/\r?\n/)
  for (const envVar of envFile) {
    const index = envVar.indexOf('=')
    if (index > 0) {
      const key = envVar.substr(0, index)
      const value = envVar.substr(index + 1)
      if (!envs[key]) {
        context.console.debug(`load env variable ${key} from ${directory} file`)
        envs[key] = value
      }
    }
  }

  return envs
}
