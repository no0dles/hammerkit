/**
 * The commands of a run in the runner of a sandbox (see kubernetes/sandbox-runner.ts), as the
 * process of the run and the registry of the server know them. A command runs apart from the
 * process that started it, with its output and exit code in a directory of the sandbox's
 * files, so a run that resumes after a restart of the server takes it up again.
 */

import { join, sep } from 'path'

// Where the directories of the commands are, relative to the root of the sandbox's files:
// hammerkit's run state, which changes, pushes, the files API and the sources of tasks leave out
export const RUNNER_COMMANDS_DIRECTORY = '.hammerkit/commands'

// the name of the directory of a run's commands, and of each command in it
export const COMMAND_ID_PATTERN = /^[0-9a-f]{24}$/

// the commands of a run the registry keeps a record of; past it, the records of the commands
// that ended make way
export const MAX_OUTPUT_COMMANDS = 1000

// How far the log of a run holds the output of a command: the bytes of its stdout and stderr
// that the lines before said
export interface CommandOutputs {
  stdout: number
  stderr: number
}

// What the registry keeps of a command of a run: which command of which task it is, how far
// the log got in its output, and whether it ended
export interface CommandRecord extends CommandOutputs {
  task: string
  step: number
  // how often the task ran in the runner before, in the run
  execution: number
  // it ended and the log holds all of its output
  done?: true
  // the log said its output was cut (at 4 MiB), which it does not say again
  cut?: true
}

// What the process of a run knows of its commands in a runner
export interface RunnerCommands {
  // the run resumed after a restart of the server: the commands it started before, by the name
  // of their directory. Only those are taken up again, any other is started anew.
  resumed?: Record<string, CommandRecord>
  // told of a command the run started, and how far its log holds its output now, after the
  // lines up to there
  reached?(command: string, record: CommandRecord): void
  // the execution the next run of each task in the runner is, by task name
  executions: Map<string, number>
  // the sandboxes whose runner a task of the run is in: one command at a time each, the other
  // tasks run as Jobs meanwhile
  inUse: Set<string>
}

export function createRunnerCommands(options: Pick<RunnerCommands, 'resumed' | 'reached'> = {}): RunnerCommands {
  // a task of a run that resumes goes on with the execution it was at: the one in flight when
  // the server stopped, or the last one, which ended
  const executions = new Map<string, number>()
  for (const record of Object.values(options.resumed ?? {})) {
    executions.set(record.task, Math.max(executions.get(record.task) ?? 0, record.execution))
  }
  return { ...options, executions, inUse: new Set() }
}

// Whether a path is in the directory of the commands of the sandbox whose files are at `root`:
// only that one, at the root of the files, not a folder of the same name deeper in them
export function isRunnerCommandsPath(path: string, root: string): boolean {
  const directory = join(root, ...RUNNER_COMMANDS_DIRECTORY.split('/'))
  return path === directory || path.startsWith(`${directory}${sep}`)
}
