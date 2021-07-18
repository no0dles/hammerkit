import { BuildFileTask } from '../parser/build-file-task'
import { platform } from 'os'
import { createHash } from 'crypto'

export function getWorkNodeId(task: BuildFileTask) {
  const hashObject = {
    shell: task.shell,
    image: task.image,
    platform: task.image ? null : platform(),
    generates: (task.generates ?? []).sort(),
    src: (task.src ? task.src.map((s) => s.relativePath) : []).sort(),
    deps: (task.deps ?? []).sort(),
    envs: task.envs ?? {},
    cmds: task.cmds ?? [],
  }

  const jsonData = JSON.stringify(hashObject, Object.keys(hashObject).sort())

  return createHash('sha1').update(jsonData).digest('hex')
}
