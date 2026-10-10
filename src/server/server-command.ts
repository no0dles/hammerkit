import { Command, CommanderError, Option } from 'commander'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { readServerConfig } from './server-config'
import { startServer } from './server'

// Runs this machine as a hammerkit server until interrupted. Like `remote`, it
// only needs its own config file, not a build file.
export function registerServerCommand(program: Command, environment: Environment): void {
  program
    .command('server')
    .description('serve this machine to remote runs (experimental)')
    .addOption(new Option('-c, --config <file>', 'server config file').env('HAMMERKIT_SERVER_CONFIG'))
    .action(async (options) => {
      try {
        if (!options.config) {
          throw new Error('pass the server config with --config or HAMMERKIT_SERVER_CONFIG')
        }
        const config = await readServerConfig(environment, options.config)
        const server = await startServer(config, environment, {
          log: (line) => environment.stdout.write(`${line}\n`),
        })
        environment.stdout.write(`hammerkit server listening on ${server.url}\n`)

        await new Promise<void>((resolve) => {
          if (environment.abortCtrl.signal.aborted) {
            resolve()
          }
          environment.abortCtrl.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        await server.close()
        environment.stdout.write('hammerkit server stopped\n')
      } catch (e) {
        if (e instanceof CommanderError) {
          throw e
        }
        program.error(`Server was not successful: ${getErrorMessage(e)}`, { exitCode: 1 })
      }
    })
}
