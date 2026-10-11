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

        // SIGHUP reads the entitlements again, so who may do what changes without
        // a restart; the rest of the config needs one
        const reload = async () => {
          try {
            const result = server.reload(await readServerConfig(environment, options.config))
            if (result.restart.length > 0) {
              environment.stdout.write(`changed but not reloaded, restart for: ${result.restart.join(', ')}\n`)
            }
          } catch (e) {
            environment.stdout.write(`entitlements were not reloaded: ${getErrorMessage(e)}\n`)
          }
        }
        const onReload = () => void reload()
        if (process.platform !== 'win32') {
          process.on('SIGHUP', onReload)
        }

        await new Promise<void>((resolve) => {
          if (environment.abortCtrl.signal.aborted) {
            resolve()
          }
          environment.abortCtrl.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        process.off('SIGHUP', onReload)
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
