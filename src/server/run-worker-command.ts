import { Command } from 'commander'
import { Environment } from '../executer/environment'
import { workerMain } from './run-worker'

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
