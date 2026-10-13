import { Command } from 'commander'
import { Environment } from '../executer/environment'
import { workerMain } from './run-worker'
import { sandboxPodMain } from './sandbox-pod'

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

// `hammerkit server-sandbox <directory>`: what a server runs in the pod of a sandbox's
// files on a cluster. It reads one request on its standard input and answers on its
// standard output. Not for people either.
export function registerSandboxPodCommand(program: Command, environment: Environment): void {
  program
    .command('server-sandbox <directory>', { hidden: true })
    .description('read or change the files of a sandbox for a hammerkit server (internal)')
    .action(async (directory: string) => {
      // tasks run as their image's user, which is not the pod's: what the pod writes, any
      // of them may change, as in a directory a host shares with its containers
      process.umask(0)
      await sandboxPodMain(directory, process.stdin, environment.stdout)
    })
}
