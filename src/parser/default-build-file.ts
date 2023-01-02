import { Environment } from '../executer/environment'
import { join } from 'path'

export async function getDefaultBuildFilename(folder: string, env: Environment): Promise<string> {
  const fileNames = ['.hammerkit.yaml', '.hammerkit.yml', 'build.yaml']
  const existingFiles: string[] = []
  for (const fileName of fileNames) {
    if (await env.file.exists(join(folder, fileName))) {
      existingFiles.push(fileName)
    }
  }
  if (existingFiles.length > 1) {
    env.console.warn(`multiple hammerkit files ${existingFiles.join(', ')} in ${folder}`)
  }
  if (existingFiles.length > 0) {
    return existingFiles[0]
  }
  return fileNames[0]
}
