import { basename, join } from 'path'
import { existsSync, readFileSync } from 'fs'
import consola from 'consola'

export function readEnvFile(path: string, baseEnv: { [key: string]: string }): { [key: string]: string } {
  const directory = join(path, '.env')
  if (!existsSync(directory)) {
    return baseEnv
  }

  let envs: { [key: string]: string } = { ...baseEnv }

  if (basename(path) !== path) {
    envs = { ...readEnvFile(basename(path), baseEnv) }
  }

  const envFile = readFileSync(directory).toString().split(/\r?\n/)
  for (const envVar of envFile) {
    const index = envVar.indexOf('=')
    if (index > 0) {
      const key = envVar.substr(0, index)
      const value = envVar.substr(index + 1)
      if (!envs[key]) {
        consola.debug(`load env variable ${key} from ${directory} file`)
        envs[key] = value
      }
    }
  }

  return envs
}
