import { BuildFileTaskCommandSchema } from '../../schema/build-file-task-command-schema'
import { WorkCommand } from '../work-command'
import { join } from 'path'
import { templateValue } from './template-value'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

export function parseWorkCommands(
  cwd: string,
  cmds: BuildFileTaskCommandSchema[],
  envs: WorkEnvironmentVariables
): WorkCommand[] {
  return cmds.map((cmd) => parseWorkCommand(cwd, cmd, envs))
}

export function parseWorkCommand(
  cwd: string,
  cmd: BuildFileTaskCommandSchema,
  envs: WorkEnvironmentVariables
): WorkCommand {
  if (typeof cmd === 'string') {
    return {
      cwd,
      ...parseCommand(cmd),
    }
  } else {
    return {
      cwd: cmd.path ? join(cwd, templateValue(cmd.path, envs)) : cwd,
      ...parseCommand(cmd.cmd),
    }
  }
}

function parseCommand(cmd: string): { parsed: { command: string; args: string[] }; cmd: string } {
  return {
    parsed: {
      command: cmd.trim().split(' ')[0],
      args: cmd.trim().split(' ').slice(1),
    },
    cmd: cmd.trim(),
  }
}
