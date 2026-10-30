import { Command } from 'commander'
import { Environment } from '../executer/environment'
import { workerMain } from './run-worker'
import { runSandboxPodCommand } from './sandbox-pod-command'

// `hammerkit server-run`: what the server starts for each run. It reads the run on its
// standard input, executes it in the current directory and reports on its standard output.
// Not for people: the input comes from the server and says which accounts it may read.
export function registerRunWorkerCommand(program: Command, environment: Environment): void {
  program
    .command('server-run', { hidden: true })
    .description('execute one run for a hammerkit server (internal)')
    .action(async () => {
      await workerMain(
        process.stdin,
        environment.stdout,
        environment.processEnvs,
        environment.cwd,
        environment.abortCtrl
      )
    })
}

// `hammerkit server-sandbox <directory>`, see sandbox-pod-command.ts. index.ts starts it
// without loading the rest of the CLI; the program has it too, as every command.
export function registerSandboxPodCommand(program: Command, environment: Environment): void {
  program
    .command('server-sandbox <directory>', { hidden: true })
    .description('read or change the files of a sandbox for a hammerkit server (internal)')
    .action(async (directory: string) => {
      await runSandboxPodCommand(directory, process.stdin, environment.stdout)
    })
}
