import { platform } from 'os'
import { WorkCommand } from '../work-command'
import { WorkTask } from '../work-task'
import { WorkService } from '../work-service'

// How an argument is quoted so the shell reads it as one word of text:
// `posix` single quotes for sh and its relatives, `powershell` single quotes
// (the shell of local tasks on Windows), `exec` none at all, for a service
// without a shell, whose command is an argument list already.
export type ArgumentQuoting = 'posix' | 'powershell' | 'exec'

const POSIX_SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'mksh']
const POWERSHELLS = ['powershell', 'pwsh']

// The quoting of a shell, by the name of its program; null for a shell whose
// quoting isn't known (fish, cmd.exe, …). Guessing would let shell syntax in an
// argument run as a second command, so such a shell takes no arguments.
export function getShellQuoting(shell: string): ArgumentQuoting | null {
  const program = shell.trim().split(/\s+/)[0] ?? ''
  const name = (program.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
  if (POSIX_SHELLS.includes(name)) {
    return 'posix'
  }
  if (POWERSHELLS.includes(name)) {
    return 'powershell'
  }
  return null
}

// Single quotes take everything literally in both shells. In sh a quote ends the
// string, so it is closed, escaped and reopened; PowerShell doubles it, and reads
// the typographic single quotes as quotes too.
export function quoteArgument(arg: string, quoting: ArgumentQuoting): string {
  if (quoting === 'powershell') {
    return `'${arg.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function appendArguments(command: WorkCommand, args: string[], quoting: ArgumentQuoting): WorkCommand {
  // an exec-form command is shown as sh would read it; it runs from `parsed`
  const display = quoting === 'exec' ? 'posix' : quoting
  return {
    cwd: command.cwd,
    cmd: [command.cmd, ...args.map((arg) => quoteArgument(arg, display))].join(' '),
    parsed: {
      command: command.parsed.command,
      args: [...command.parsed.args, ...args],
    },
    arguments: { cmd: command.cmd.length, args: command.parsed.args.length },
  }
}

// Kubernetes expands `$(NAME)` with the container's env and turns `$$` into `$`
// in a container's command and args, before any shell sees them, so a quoted
// argument isn't text there unless its `$` is doubled. The part of the command
// the build file declares keeps its meaning.
export function escapeKubernetesText(text: string): string {
  return text.replace(/\$/g, '$$$$')
}

export function getKubernetesCommandText(command: WorkCommand): string {
  if (!command.arguments) {
    return command.cmd
  }
  const from = command.arguments.cmd
  return command.cmd.slice(0, from) + escapeKubernetesText(command.cmd.slice(from))
}

export function getKubernetesCommandArgs(command: WorkCommand): string[] {
  const from = command.arguments?.args ?? command.parsed.args.length
  return command.parsed.args.map((arg, index) => (index >= from ? escapeKubernetesText(arg) : arg))
}

// The command arguments after `--` land in: the last command of a task, the
// `cmd` of a container service. Null when there is none.
export function getArgumentsTarget(item: WorkTask | WorkService): WorkCommand | null {
  if (item.type === 'local-task' || item.type === 'container-task') {
    return item.cmds[item.cmds.length - 1] ?? null
  }
  if (item.type === 'container-service') {
    return item.cmd
  }
  return null
}

export interface ArgumentsSelection {
  tasks: WorkTask[]
  services: WorkService[]
}

// Appends the arguments to the one task or service a run selects, before
// anything asks for its id: the last command is part of the task id, so the
// arguments are part of its cache key. A run with arguments is a one-off (one
// test, one flag), so the task skips the cache unless `keepCache`; even then the
// key keeps runs with other arguments apart. Dependencies and needed services
// are planned items of their own and keep their commands and caching. No
// arguments change nothing, so a task run without them keeps its cache entries.
export function applyArguments(selection: ArgumentsSelection, args: string[], keepCache = false): void {
  if (args.length === 0) {
    return
  }
  const selected = [...selection.tasks, ...selection.services]
  if (selected.length === 0) {
    return
  }
  if (selected.length > 1) {
    throw new Error(
      `arguments after -- go to one task or service, but this run selects ${selected.map((s) => s.name).join(', ')}`
    )
  }
  if (args.some((arg) => arg.includes('\0'))) {
    throw new Error('an argument after -- contains a NUL character')
  }

  const item = selected[0]
  if (item.type === 'kubernetes-service') {
    throw new Error(`service ${item.name} is a kubernetes service and has no cmd for the arguments after --`)
  }
  if (item.args === false) {
    throw new Error(
      `${item.type === 'container-service' ? 'service' : 'task'} ${item.name} takes no arguments after -- (args: false)`
    )
  }
  const target = getArgumentsTarget(item)
  if (!target) {
    throw new Error(
      item.type === 'container-service'
        ? `service ${item.name} has no cmd for the arguments after --`
        : `task ${item.name} has no command for the arguments after --`
    )
  }

  const quoting = getItemQuoting(item)
  if (item.type === 'local-task' && quoting === 'powershell') {
    const refused = args.find(isRefusedByWindowsPowerShell)
    if (refused !== undefined) {
      throw new Error(
        `task ${item.name} runs in Windows PowerShell, which would split or run the argument ${JSON.stringify(
          refused
        )}, so it is refused: an empty argument, a ", the characters & | < > ^ % !, line breaks, and a space with a trailing \\`
      )
    }
  }
  if (item.type === 'container-service') {
    item.cmd = appendArguments(target, args, quoting)
  } else {
    item.cmds = [...item.cmds.slice(0, -1), appendArguments(target, args, quoting)]
    if (!keepCache) {
      // not implicit, so the run's --cache default doesn't bring the method back
      item.caching = { ...item.caching, method: 'none', implicit: false }
    }
  }
}

// Windows PowerShell 5.1 builds a new command line for a native program, and
// starts a .cmd or .bat shim (yarn.cmd, most of node_modules/.bin) through
// cmd.exe. There an empty argument is dropped, a " splits or joins arguments,
// an argument with a space that ends in \ is quoted as "a b\" and so escapes
// its own closing quote, and cmd reads & | < > ^ % ! and a line break as
// syntax, so such an argument can't be passed as text.
export function isRefusedByWindowsPowerShell(arg: string): boolean {
  return arg === '' || /["&|<>^%!\r\n]/.test(arg) || (/\s/.test(arg) && arg.endsWith('\\'))
}

function getItemQuoting(item: WorkTask | WorkService): ArgumentQuoting {
  if (item.type === 'local-task') {
    // what executeCommand runs a local command in
    return platform() === 'win32' ? 'powershell' : 'posix'
  }
  const shell = item.type === 'kubernetes-service' ? null : item.shell
  if (shell === null) {
    return 'exec'
  }
  const quoting = getShellQuoting(shell)
  if (!quoting) {
    throw new Error(
      `${item.type === 'container-task' ? 'task' : 'service'} ${item.name} runs in ${shell}, whose quoting hammerkit ` +
        `doesn't know, so it takes no arguments after --; use sh, bash, zsh, dash, ash, ksh, mksh or PowerShell`
    )
  }
  return quoting
}
