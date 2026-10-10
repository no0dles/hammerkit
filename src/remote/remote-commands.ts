import { Command, CommanderError, Option } from 'commander'
import colors from 'colors'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { addServer, getHostConfigPath, readHostConfig, removeServer, setDefaultLocation } from './host-config'

// Host-level commands: they only touch the machine's config file, so they work
// with or without a build file in the working directory.
export function registerRemoteCommands(program: Command, environment: Environment): void {
  const remote = program.command('remote').description('register the servers runs can be sent to')

  const guarded = (failure: string, fn: (...args: any[]) => Promise<void>) => {
    return async (...args: any[]) => {
      try {
        await fn(...args)
      } catch (e) {
        if (e instanceof CommanderError) {
          throw e
        }
        program.error(`${failure}: ${getErrorMessage(e)}`, { exitCode: 1 })
      }
    }
  }

  remote
    .command('add <name> <url>')
    .description('register a server under a name that build files and --on can refer to')
    .addOption(new Option('--issuer <url>', 'OAuth issuer the server accepts tokens from').makeOptionMandatory())
    .addOption(new Option('--force', 'point an already registered name at a different server').default(false))
    .action(
      guarded('Remote add was not successful', async (name: string, url: string, options) => {
        const server = await addServer(environment, name, url, { issuer: options.issuer, force: options.force })
        environment.stdout.write(`added ${name}: ${server.url} (issuer ${server.issuer})\n`)
      })
    )

  remote
    .command('list')
    .description('list the registered servers')
    .action(
      guarded('Remote list was not successful', async () => {
        const config = await readHostConfig(environment)
        const names = Object.keys(config.servers).sort()
        if (names.length === 0) {
          environment.stdout.write(`no servers registered (config: ${getHostConfigPath(environment)})\n`)
          return
        }
        for (const name of names) {
          const server = config.servers[name]
          const marker = config.run.on === name ? colors.green(' (default)') : ''
          environment.stdout.write(`${colors.bold(name)}${marker}  ${server.url}  issuer ${server.issuer}\n`)
        }
        if (config.run.on === 'auto' || config.run.on === 'local') {
          environment.stdout.write(`default location: ${config.run.on}\n`)
        }
      })
    )

  remote
    .command('remove <name>')
    .description('forget a registered server')
    .action(
      guarded('Remote remove was not successful', async (name: string) => {
        const { resetDefault } = await removeServer(environment, name)
        environment.stdout.write(`removed ${name}\n`)
        if (resetDefault) {
          environment.stdout.write('it was the default location, runs are local again\n')
        }
      })
    )

  remote
    .command('use <location>')
    .description('set where runs happen by default: local, auto or a registered server')
    .action(
      guarded('Remote use was not successful', async (location: string) => {
        await setDefaultLocation(environment, location)
        environment.stdout.write(`default location: ${location}\n`)
      })
    )
}
