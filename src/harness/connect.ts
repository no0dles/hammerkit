import { exec } from 'child_process'
import { Environment } from '../executer/environment'
import { getFileContext } from '../file/get-file-context'
import { consoleContext } from '../log'
import { statusConsole } from '../planner/work-item-status'
import { getAccessToken } from '../remote/credentials'
import { hasServer, readHostConfig } from '../remote/host-config'
import { createSecretRegistry } from '../utils/redact'
import { emptyWritable } from '../utils/empty-writable'
import { SandboxClient, ServerConnection } from './sandbox-client'

export const DEFAULT_SHELL_TASK = 'sh'

/**
 * Where a harness works: a registered server, one of the caller's sandboxes on it (or a
 * repository and ref to create one from), and the published build file whose tasks run on
 * it, with the task that is the shell.
 */
export interface HarnessOptions {
  server?: string
  sandbox?: string
  repo?: string
  ref?: string
  build?: string
  shell?: string
}

// The same settings as variables, for harnesses that load hammerkit as a plugin.
export function harnessOptionsFromEnv(env: { [key: string]: string | undefined }): HarnessOptions {
  const value = (name: string) => (env[name] && env[name]?.trim()) || undefined
  return {
    server: value('HAMMERKIT_SERVER'),
    sandbox: value('HAMMERKIT_SANDBOX'),
    repo: value('HAMMERKIT_REPO'),
    ref: value('HAMMERKIT_REF'),
    build: value('HAMMERKIT_BUILD'),
    shell: value('HAMMERKIT_SHELL'),
  }
}

/**
 * The token a harness sends, in this order:
 *
 * - `HAMMERKIT_TOKEN_COMMAND`: a command that prints a short-lived token of the agent's own
 *   identity, such as a workload identity or a service account of the identity provider. It
 *   runs again when the server no longer accepts the token.
 * - `HAMMERKIT_TOKEN`: such a token, as the agent's platform hands it over.
 * - the sign-in of `hammerkit remote login <server>`.
 *
 * The token only goes to the URL the server is registered with in the host config.
 */
export function getTokenSource(
  environment: Environment,
  name: string,
  server: { url: string; issuer: string }
): Pick<ServerConnection, 'token' | 'renew'> {
  const command = environment.processEnvs.HAMMERKIT_TOKEN_COMMAND
  if (command) {
    let current: Promise<string> | undefined
    const run = () =>
      new Promise<string>((resolve, reject) => {
        exec(command, { env: environment.processEnvs, timeout: 60_000 }, (error, stdout) => {
          const token = String(stdout).trim()
          if (error || !token) {
            reject(new Error('HAMMERKIT_TOKEN_COMMAND printed no token'))
          } else {
            resolve(token)
          }
        })
      })
    return {
      token: () => {
        current = current ?? run()
        current.catch(() => (current = undefined))
        return current
      },
      renew: async () => {
        current = undefined
      },
    }
  }
  const fixed = environment.processEnvs.HAMMERKIT_TOKEN
  if (fixed) {
    return { token: async () => fixed }
  }
  return { token: () => getAccessToken(environment, name, server) }
}

export async function connectSandbox(
  environment: Environment,
  options: HarnessOptions,
  log: (line: string) => void = () => undefined
): Promise<SandboxClient> {
  const config = await readHostConfig(environment)
  const name = options.server ?? config.run.on
  if (!name || !hasServer(config.servers, name)) {
    throw new Error(
      options.server
        ? `server ${options.server} is not registered, add it with: hammerkit remote add ${options.server} <url> --issuer <url>`
        : 'name a server (HAMMERKIT_SERVER or --server), or set a default with: hammerkit remote use <name>'
    )
  }
  if (!options.build) {
    throw new Error('name the published build file whose tasks run on the sandbox (HAMMERKIT_BUILD or --build)')
  }
  const server = config.servers[name]
  const connection: ServerConnection = { url: server.url, ...getTokenSource(environment, name, server) }
  let sandbox
  if (options.sandbox) {
    sandbox = await SandboxClient.get(connection, options.sandbox)
  } else if (options.repo && options.ref) {
    sandbox = await SandboxClient.create(connection, options.repo, options.ref)
    log(`created sandbox ${sandbox.id} of ${sandbox.repo} at ${sandbox.commit} on ${name}`)
  } else {
    throw new Error(
      'name a sandbox (HAMMERKIT_SANDBOX or --sandbox), or a repository and ref to create one from (HAMMERKIT_REPO and HAMMERKIT_REF, or --repo and --ref)'
    )
  }
  return new SandboxClient(connection, sandbox, { name: options.build, shell: options.shell ?? DEFAULT_SHELL_TASK })
}

// What hammerkit needs of its environment to read the host config and the sign-in, for a
// harness that loads it as a plugin rather than through the command line.
export function getHarnessEnvironment(cwd: string = process.cwd()): Environment {
  const secrets = createSecretRegistry()
  return {
    cwd,
    abortCtrl: new AbortController(),
    processEnvs: process.env,
    file: getFileContext(cwd),
    console: consoleContext(emptyWritable()),
    status: statusConsole(emptyWritable(), secrets),
    secrets,
    stdout: emptyWritable(),
    stderr: emptyWritable(),
    stdoutColumns: 80,
  }
}
