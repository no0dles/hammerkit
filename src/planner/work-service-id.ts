import { BuildFile } from '../parser/build-file'
import { ExecutionBuildService } from '../parser/build-file-service'
import { createHash } from 'crypto'

export function getWorkServiceId(buildFile: BuildFile, service: ExecutionBuildService): string {
  const jsonData = JSON.stringify({
    path: buildFile.path,
    image: service.image,
  })
  return createHash('sha1').update(jsonData).digest('hex')
}
