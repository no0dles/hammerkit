import { Command, CommanderError, Option } from 'commander'
import colors from 'colors'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import {
  addServer,
  pinLogin,
  getHostConfigPath,
  hasServer,
  HostServer,
  readHostConfig,
  removeServer,
  setDefaultLocation,
} from './host-config'
import { deviceLogin } from './device-login'
import { getAccessToken, removeToken, saveToken } from './credentials'
import { getMe } from './server-client'

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
    .addOption(new Option('--client-id <id>', 'OAuth client to sign in with (pinned; default: what the server offers)'))
    .addOption(new Option('--audience <audience>', 'audience of the token (pinned; default: what the server offers)'))
    .addOption(new Option('--scope <scope>', 'scopes to request (pinned; default: what the server offers)'))
    .addOption(new Option('--force', 'point an already registered name at a different server').default(false))
    .action(
      guarded('Remote add was not successful', async (name: string, url: string, options) => {
        const server = await addServer(environment, name, url, {
          issuer: options.issuer,
          clientId: options.clientId,
          audience: options.audience,
          scope: options.scope,
          force: options.force,
        })
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

  const getServer = async (name: string | undefined): Promise<{ name: string; server: HostServer }> => {
    const config = await readHostConfig(environment)
    const chosen = name ?? config.run.on
    if (!chosen || !hasServer(config.servers, chosen)) {
      throw new Error(
        name
          ? `server ${name} is not registered, add it with: hammerkit remote add ${name} <url> --issuer <url>`
          : 'name a server, or set one as the default with: hammerkit remote use <name>'
      )
    }
    return { name: chosen, server: config.servers[chosen] }
  }

  remote
    .command('login <name>')
    .description('sign in to a registered server with your identity provider (device code, works headless)')
    .action(
      guarded('Remote login was not successful', async (name: string) => {
        const { server } = await getServer(name)
        const { pinned, ...result } = await deviceLogin(server, {
          prompt: (message) => environment.stdout.write(`${message}\n`),
          signal: environment.abortCtrl.signal,
        })
        await pinLogin(environment, name, pinned)
        await saveToken(environment, name, { url: server.url, issuer: server.issuer, ...result })
        try {
          const me = await getMe(server, result.accessToken)
          environment.stdout.write(`signed in to ${name} as ${me.sub}\n`)
          environment.stdout.write(
            me.accounts.length > 0
              ? `service accounts: ${me.accounts.join(', ')}\n`
              : 'you have no service accounts on this server\n'
          )
        } catch (e) {
          // a token the server does not accept is of no use
          await removeToken(environment, name)
          throw e
        }
      })
    )

  remote
    .command('logout <name>')
    .description('forget the sign-in to a server')
    .action(
      guarded('Remote logout was not successful', async (name: string) => {
        const removed = await removeToken(environment, name)
        environment.stdout.write(removed ? `signed out of ${name}\n` : `not signed in to ${name}\n`)
      })
    )

  remote
    .command('accounts [name]')
    .description('show who you are on a server and which service accounts you may use')
    .action(
      guarded('Remote accounts was not successful', async (name: string | undefined) => {
        const chosen = await getServer(name)
        const token = await getAccessToken(environment, chosen.name, chosen.server)
        const me = await getMe(chosen.server, token)
        environment.stdout.write(`${chosen.name}: ${me.sub} (${me.iss})\n`)
        if (me.accounts.length === 0 && !(me.request && me.request.length > 0)) {
          environment.stdout.write('no service accounts\n')
        }
        for (const account of me.accounts) {
          environment.stdout.write(`${account}${account === me.default ? colors.green(' (default)') : ''}\n`)
        }
        if (me.publish && me.publish.length > 0) {
          environment.stdout.write(`may publish build files: ${me.publish.join(', ')}\n`)
        }
        if (me.request && me.request.length > 0) {
          environment.stdout.write(`may request runs, which an admin approves: ${me.request.join(', ')}\n`)
        }
      })
    )
}
