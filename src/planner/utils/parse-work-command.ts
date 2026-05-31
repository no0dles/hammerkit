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
  const tokens = tokenizeCommand(cmd)
  return {
    parsed: {
      command: tokens[0] ?? '',
      args: tokens.slice(1),
    },
    cmd: cmd.trim(),
  }
}

/**
 * Split a command line into tokens the way a shell roughly would: whitespace
 * separates arguments, but single/double quotes group one argument and are
 * stripped. Needed because the parsed command/args feed exec-form targets
 * (docker `Cmd`, k8s job args, the packaged image's `CMD [...]`), where a naive
 * `split(' ')` turns `sh -c "echo hi && sleep 1"` into broken tokens like
 * `"echo`, `hi`, `1"`. The raw `cmd` string is kept untouched for shell-form
 * use (e.g. Dockerfile `RUN`).
 */
export function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null

  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
    } else {
      current += ch
      inToken = true
    }
  }

  if (inToken) {
    tokens.push(current)
  }

  return tokens
}
