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
import { deviceLogin, NoSignInError } from './device-login'
import { removeToken, saveToken } from './credentials'
import { getTokenSource } from './token-source'
import { callServer, getMe, printable } from './server-client'
import { registerWorkCommands } from './remote-work-commands'
import { registerMcpCommand } from '../harness/mcp-command'

// Host-level commands: they only touch the machine's config file, so they work
// with or without a build file in the working directory.
export function registerRemoteCommands(
  program: Command,
  environment: Environment,
  buildFile: string,
  // what follows `--`, the arguments of `remote run`
  passthrough: string[] = []
): void {
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
    .addOption(
      new Option(
        '--token-command <command>',
        'a command that prints the token for this server, instead of remote login (e.g. of a service account)'
      )
    )
    .addOption(new Option('--no-token-command', 'remove the token command, sign in with remote login again'))
    .addOption(new Option('--force', 'point an already registered name at a different server').default(false))
    .action(
      guarded('Remote add was not successful', async (name: string, url: string, options) => {
        const server = await addServer(environment, name, url, {
          issuer: options.issuer,
          clientId: options.clientId,
          audience: options.audience,
          scope: options.scope,
          tokenCommand: options.tokenCommand,
          force: options.force,
        })
        environment.stdout.write(`added ${name}: ${server.url} (issuer ${server.issuer})\n`)
        if (server.tokenCommand) {
          environment.stdout.write(`tokens for ${name} come from: ${server.tokenCommand}\n`)
        }
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
          const token = server.tokenCommand ? `  token from: ${server.tokenCommand}` : ''
          environment.stdout.write(`${colors.bold(name)}${marker}  ${server.url}  issuer ${server.issuer}${token}\n`)
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
        if (server.tokenCommand) {
          // a sign-in would never be used: the command's token goes first
          throw new Error(
            `${name} takes its tokens from its token command (${server.tokenCommand}), it needs no sign-in; ` +
              `to sign in instead, remove it with: hammerkit remote add ${name} ${server.url} --issuer ${server.issuer} --no-token-command`
          )
        }
        let login
        try {
          login = await deviceLogin(server, {
            prompt: (message) => environment.stdout.write(`${message}\n`),
            signal: environment.abortCtrl.signal,
          })
        } catch (e) {
          if (e instanceof NoSignInError) {
            throw new Error(
              `${e.message}: register a command that prints one, such as the token of a service account, with: ` +
                `hammerkit remote add ${name} ${server.url} --issuer ${server.issuer} --token-command '<command>'`
            )
          }
          throw e
        }
        const { pinned, ...result } = login
        await pinLogin(environment, name, pinned)
        await saveToken(environment, name, { url: server.url, issuer: server.issuer, ...result })
        try {
          const me = await getMe(server, result.accessToken)
          environment.stdout.write(`signed in to ${name} as ${me.sub}\n`)
          environment.stdout.write(
            me.accounts.length > 0
              ? `service accounts: ${me.accounts.map((a) => `${printable(a.name)} (${a.level})`).join(', ')}\n`
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
        const token = await getTokenSource(environment, chosen.name, chosen.server).token()
        const me = await getMe(chosen.server, token)
        const { body } = await callServer<{
          accounts: { name: string; description?: string; level: 'use' | 'request'; sources: string[] }[]
        }>(chosen.server, token, 'GET', '/v1/accounts')
        environment.stdout.write(`${chosen.name}: ${printable(me.sub)} (${printable(me.iss)})\n`)
        if (body.accounts.length === 0) {
          environment.stdout.write('no service accounts\n')
        }
        for (const account of body.accounts) {
          const level = account.level === 'use' ? 'use' : 'request, somebody who uses it approves'
          environment.stdout.write(
            `${colors.bold(printable(account.name))}  ${level}${
              account.description ? `  ${printable(account.description)}` : ''
            }  from ${account.sources.map(printable).join(', ')}\n`
          )
        }
        if (me.builds) {
          const may = {
            run: 'run published build files',
            propose: 'propose build files, which somebody who publishes approves',
            publish: 'publish build files',
          }[me.builds]
          environment.stdout.write(`you may ${may}\n`)
        }
        if (me.repos.length > 0) {
          environment.stdout.write(`repositories: ${me.repos.map(printable).join(', ')}\n`)
        }
      })
    )

  registerWorkCommands(remote, {
    environment,
    buildFile,
    getServer,
    guarded,
    passthrough,
    fail: (message, exitCode) => program.error(message, { exitCode }),
  })
  registerMcpCommand(remote, environment)
}
