import { BuildTaskCommand } from './build-file-task-command'
import { ParseContext, parseContextDescription } from './parse-context'

export function parseBuildFileCommand(ctx: ParseContext, value: unknown): BuildTaskCommand[] | null {
  if (!value) {
    return null
  }

  if (!(value instanceof Array)) {
    throw new Error(`${parseContextDescription(ctx)} cmds needs to be an array`)
  }

  return value.map<BuildTaskCommand>((cmd) => {
    if (typeof cmd === 'string') {
      return cmd.trim()
    } else if (typeof cmd === 'object' && !!cmd.cmd) {
      if (!(typeof cmd.cmd === 'string')) {
        throw new Error(`${parseContextDescription(ctx)} cmd needs to be a string`)
      }

      if (cmd.path) {
        if (!(typeof cmd.path === 'string')) {
          throw new Error(`${parseContextDescription(ctx)} cmd path needs to be a string`)
        }
        return { cmd: cmd.cmd.trim(), path: cmd.path, type: 'cmd' }
      } else {
        return { cmd: cmd.cmd.trim(), type: 'cmd', path: null }
      }
    } else {
      throw new Error(`${parseContextDescription(ctx)} unknown cmd`)
    }
  })
}
