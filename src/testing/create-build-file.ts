import { parseBuildFile } from '../parser/parse-build-file'
import { Environment } from '../executer/environment'

export function createBuildFile(env: Environment, buildFile: any) {
  return parseBuildFile(`${env.cwd}/build.yaml`, {}, buildFile, env)
}
