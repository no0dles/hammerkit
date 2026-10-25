import { Command, CommanderError, Option } from 'commander'
import { Readable } from 'stream'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { getVersion } from '../version'
import { connectSandbox, DEFAULT_SHELL_TASK } from './connect'
import { createMcpTools, serveMcp } from './mcp'
import { SandboxClient } from './sandbox-client'
import { TaskListing } from './task-tools'

// the tasks run_task lists; a server that does not answer leaves them out, the tools still work
async function listTasks(sandbox: SandboxClient, log: (line: string) => void): Promise<TaskListing> {
  try {
    return await sandbox.tasks()
  } catch (e) {
    log(`the tasks of ${sandbox.build.hash} could not be listed: ${getErrorMessage(e)}`)
    return { error: getErrorMessage(e) }
  }
}

// `hammerkit remote mcp`: a Model Context Protocol server on stdio for one sandbox of a
// server. It lives under `remote`, which already is a command: a top-level `mcp` would hide a
// task named `mcp`, since `hammerkit <task>` runs a task. Like the other `remote` commands it
// needs no build file of its own: the tasks are the published ones.
export function registerMcpCommand(remote: Command, environment: Environment, input: Readable = process.stdin): void {
  // errors go through the program, like those of the other remote commands: it carries the exit handling
  const program = remote.parent ?? remote
  remote
    .command('mcp')
    .description('serve the files, shell and tasks of a sandbox on a server as MCP tools over stdio (experimental)')
    .addOption(
      new Option('--server <name>', 'registered server (default: hammerkit remote use)').env('HAMMERKIT_SERVER')
    )
    .addOption(new Option('--sandbox <id>', 'a sandbox of yours on the server').env('HAMMERKIT_SANDBOX'))
    .addOption(new Option('--repo <repo>', 'create a sandbox of this repository').env('HAMMERKIT_REPO'))
    .addOption(new Option('--ref <ref>', 'at this branch').env('HAMMERKIT_REF'))
    .addOption(
      new Option('--build <hash>', 'hash of the published version of the build file whose tasks run on it').env(
        'HAMMERKIT_BUILD'
      )
    )
    .addOption(
      new Option('--shell <task>', "its task whose last command is a shell, like sh -c; '' for no bash tool")
        .env('HAMMERKIT_SHELL')
        .default(DEFAULT_SHELL_TASK)
    )
    .action(async (options) => {
      try {
        // stdout carries the protocol only, everything else goes to stderr
        const log = (line: string) => environment.stderr.write(`hammerkit remote mcp: ${line}\n`)
        const sandbox = await connectSandbox(environment, options, log)
        log(`sandbox ${sandbox.id} of ${sandbox.sandbox.repo} at ${sandbox.sandbox.commit}`)
        const shell = sandbox.build.shell
        const instructions =
          `The tools work on hammerkit sandbox ${sandbox.id}, a checkout of ${sandbox.sandbox.repo} at ` +
          `${sandbox.sandbox.commit} on a server. Paths are relative to its root. ` +
          (shell
            ? `bash runs a command as the task ${shell} of the published build file ${sandbox.build.hash}, ` +
              'run_task runs its other tasks; only the files are kept between commands. '
            : `run_task runs the tasks of the published build file ${sandbox.build.hash}; only the files are ` +
              'kept between runs. ') +
          'changes shows what changed since the fetch.'
        const tasks = await listTasks(sandbox, log)
        const served = serveMcp(
          input,
          environment.stdout,
          createMcpTools(async () => sandbox, { tasks, shell: shell || false }),
          {
            name: 'hammerkit',
            version: getVersion(),
            instructions,
          }
        )
        const stopped = new Promise<void>((resolve) => {
          if (environment.abortCtrl.signal.aborted) {
            resolve()
          }
          environment.abortCtrl.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        await Promise.race([served, stopped])
      } catch (e) {
        if (e instanceof CommanderError) {
          throw e
        }
        program.error(`Mcp was not successful: ${getErrorMessage(e)}`, { exitCode: 1 })
      }
    })
}
