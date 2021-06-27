import { BuildFileTaskSource } from './build-file-task-source'
import { BuildTaskCommand } from './build-file-task-command'

export interface BuildFileTask {
  deps: string[] | null
  src: BuildFileTaskSource[] | null
  description: string | null
  shell: string | null
  generates: string[] | null
  extend: string | null
  image: string | null
  mounts: string[] | null
  cmds: BuildTaskCommand[] | null
  envs: { [key: string]: string } | null
  unknownProps: { [key: string]: any }
}
