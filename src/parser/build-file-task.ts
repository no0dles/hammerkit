import { BuildFileTaskSource } from './build-file-task-source'
import { BuildTaskCommand } from './build-file-task-command'
import { BuildFileTaskPlatform } from './build-file-task-platform'
import { CacheMethod } from './cache-method'

export interface BuildFileTask {
  deps: string[] | null
  src: BuildFileTaskSource[] | null
  continuous: boolean | null
  platform: BuildFileTaskPlatform | null
  description: string | null
  shell: string | null
  generates: string[] | null
  extend: string | null
  image: string | null
  mounts: string[] | null
  cmds: BuildTaskCommand[] | null
  needs: string[] | null
  envs: { [key: string]: string } | null
  ports: string[] | null
  unknownProps: { [key: string]: any }
  labels: { [key: string]: string }
  cache: CacheMethod | null
}
