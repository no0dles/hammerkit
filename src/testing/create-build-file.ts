import { parseBuildFile } from '../parser/parse-build-file'
import { Environment } from '../executer/environment'
import { BuildFile } from '../parser/build-file'

export function createBuildFile(env: Environment, buildFile: unknown): Promise<BuildFile> {
  return parseBuildFile(`${env.cwd}/build.yaml`, {}, buildFile, env)
}
