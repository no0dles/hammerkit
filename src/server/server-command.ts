import { Command, CommanderError, Option } from 'commander'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { readServerConfig } from './server-config'
import { RunningServer, startServer } from './server'
import { takeOverSignal } from '../utils/abort-on-signals'

// Runs this machine as a hammerkit server until interrupted. Like `remote`, it
// only needs its own config file, not a build file.
export function registerServerCommand(program: Command, environment: Environment): void {
  program
    .command('server')
    .description('serve this machine to remote runs (experimental)')
    .addOption(new Option('-c, --config <file>', 'server config file').env('HAMMERKIT_SERVER_CONFIG'))
    .action(async (options) => {
      // SIGHUP reads the entitlements again, so who may do what changes without a
      // restart; the rest of the config needs one. The server takes it over from the
      // abort of the CLI, which stops other commands on it, before it starts: a SIGHUP
      // while it reads its config and starts waits for it. Windows sends SIGHUP when the
      // console closes, which stops the server there too.
      let server: RunningServer | undefined
      let reloadWhenStarted = false
      const reload = async (running: RunningServer) => {
        try {
          const result = running.reload(await readServerConfig(environment, options.config))
          if (result.restart.length > 0) {
            environment.stdout.write(`changed but not reloaded, restart for: ${result.restart.join(', ')}\n`)
          }
        } catch (e) {
          environment.stdout.write(`entitlements were not reloaded: ${getErrorMessage(e)}\n`)
        }
      }
      const releaseReload =
        process.platform !== 'win32'
          ? takeOverSignal(process, 'SIGHUP', () => {
              if (server) {
                void reload(server)
              } else {
                reloadWhenStarted = true
              }
            })
          : () => undefined
      try {
        if (!options.config) {
          throw new Error('pass the server config with --config or HAMMERKIT_SERVER_CONFIG')
        }
        const config = await readServerConfig(environment, options.config)
        const running = await startServer(config, environment, {
          log: (line) => environment.stdout.write(`${line}\n`),
        })
        server = running
        environment.stdout.write(`hammerkit server listening on ${running.url}\n`)
        if (reloadWhenStarted) {
          void reload(running)
        }

        await new Promise<void>((resolve) => {
          if (environment.abortCtrl.signal.aborted) {
            resolve()
          }
          environment.abortCtrl.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        releaseReload()
        await running.close()
        environment.stdout.write('hammerkit server stopped\n')
      } catch (e) {
        if (e instanceof CommanderError) {
          throw e
        }
        program.error(`Server was not successful: ${getErrorMessage(e)}`, { exitCode: 1 })
      } finally {
        releaseReload()
      }
    })
}
