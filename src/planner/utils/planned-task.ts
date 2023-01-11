import { BuildFile } from '../../parser/build-file'
import { BuildFileTask } from '../../parser/build-file-task'
import { BuildFileTaskSource } from '../../parser/build-file-task-source'
import { BuildFileTaskPlatform } from '../../parser/build-file-task-platform'
import { WorkNodeGenerate } from '../work-node'
import { BuildTaskCommand } from '../../parser/build-file-task-command'
import { CacheMethod } from '../../parser/cache-method'
import { BuildFileReference } from './build-file-reference'

export interface PlannedTask {
  build: BuildFile
  buildTask: BuildFileTask
  name: string
  cwd: string
  continuous: boolean
  deps: BuildFileReference[]
  src: BuildFileTaskSource[]
  platform: BuildFileTaskPlatform | null
  description: string | null
  shell: string | null
  generates: WorkNodeGenerate[]
  image: string | null
  mounts: string[]
  cmds: BuildTaskCommand[]
  needs: { name: string; reference: BuildFileReference }[]
  envs: { [key: string]: string }
  ports: string[]
  labels: { [key: string]: string }
  cache: CacheMethod | null
}
