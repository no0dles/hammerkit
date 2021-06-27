import { BuildTaskCommand } from './build-file-task-command'

export function parseBuildFileCommand(fileName: string, taskName: string, value: any): BuildTaskCommand[] | null {
  if (!value) {
    return null
  }

  if (!(value instanceof Array)) {
    throw new Error(`${fileName} task ${taskName} cmds needs to be an array`)
  }

  return value.map<BuildTaskCommand>((cmd) => {
    if (typeof cmd === 'string') {
      return cmd.trim()
    } else if (typeof cmd === 'object' && !!cmd.cmd) {
      if (!(typeof cmd.cmd === 'string')) {
        throw new Error(`${fileName} task ${taskName} cmd needs to be a string`)
      }

      if (cmd.path) {
        if (!(typeof cmd.path === 'string')) {
          throw new Error(`${fileName} task ${taskName} cmd path needs to be a string`)
        }
        return { cmd: cmd.cmd.trim(), path: cmd.path, type: 'cmd' }
      } else {
        return { cmd: cmd.cmd.trim(), type: 'cmd', path: null }
      }
    } else {
      throw new Error(`${fileName} task ${taskName} unknown cmd`)
    }
  })
}
