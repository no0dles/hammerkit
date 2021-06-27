import { join } from 'path'
import { BuildTaskCommand } from '../../parser/build-file-task-command'
import { WorkNodeCommand } from '../work-node-command'

export function planWorkCommand(cmds: BuildTaskCommand[], workingDir: string): WorkNodeCommand[] {
  const result: WorkNodeCommand[] = []
  for (const cmd of cmds) {
    if (typeof cmd === 'string') {
      result.push({ cmd: cmd, path: workingDir })
    } else {
      result.push({
        cmd: cmd.cmd,
        path: join(workingDir, cmd.path || ''),
      })
    }
  }
  return result
}
