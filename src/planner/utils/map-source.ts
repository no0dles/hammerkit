import { BuildFileTaskSource } from '../../parser/build-file-task-source'
import { WorkNodeSource } from '../work-node-source'
import { join } from 'path'

export function mapSource(src: BuildFileTaskSource, workDir: string): WorkNodeSource {
  return {
    matcher: src.matcher,
    absolutePath: join(workDir, src.relativePath),
  }
}
