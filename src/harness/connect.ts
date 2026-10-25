import { Environment } from '../executer/environment'
import { getFileContext } from '../file/get-file-context'
import { consoleContext } from '../log'
import { statusConsole } from '../planner/work-item-status'
import { hasServer, readHostConfig } from '../remote/host-config'
import { createSecretRegistry } from '../utils/redact'
import { emptyWritable } from '../utils/empty-writable'
import { getTokenSource } from '../remote/token-source'
import { HASH_PATTERN } from '../remote/bundle'
import { SandboxClient, SandboxView, ServerConnection } from './sandbox-client'

export const DEFAULT_SHELL_TASK = 'sh'

/**
 * Where a harness works: a registered server, one of the caller's sandboxes on it (or a
 * repository and ref to create one from), and the published version of the build file whose
 * tasks run on it, by its hash, with the task that is the shell: `''` for none, the clients
 * then leave their shell tool out and run named tasks only.
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
    // set but empty is no shell, unset the default one
    shell: env.HAMMERKIT_SHELL !== undefined ? env.HAMMERKIT_SHELL.trim() : undefined,
  }
}

// whether the clients offer a shell tool
export function hasShell(options: HarnessOptions): boolean {
  return options.shell !== ''
}

/**
 * The registered server a harness works on and the published version it runs, checked:
 * what the clients need to list the tasks of the version before they take a sandbox.
 */
export async function connectServer(
  environment: Environment,
  options: HarnessOptions
): Promise<{ name: string; connection: ServerConnection; build: string }> {
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
    throw new Error(
      'name the published version of the build file whose tasks run on the sandbox by its hash (HAMMERKIT_BUILD or --build), as hammerkit remote publish printed it'
    )
  }
  // a run names exactly the version it runs, there is no name that follows the latest one
  if (!HASH_PATTERN.test(options.build)) {
    throw new Error(
      `${options.build} is not the hash of a published version (sha256:...), name it as hammerkit remote publish printed it (HAMMERKIT_BUILD or --build)`
    )
  }
  const server = config.servers[name]
  return { name, connection: { url: server.url, ...getTokenSource(environment, name, server) }, build: options.build }
}

export async function connectSandbox(
  environment: Environment,
  options: HarnessOptions,
  log: (line: string) => void = () => undefined
): Promise<SandboxClient> {
  const { name, connection, build } = await connectServer(environment, options)
  let sandbox
  if (options.sandbox) {
    sandbox = await SandboxClient.get(connection, options.sandbox)
  } else if (options.repo && options.ref) {
    sandbox = await reuseSandbox(connection, options.repo, options.ref)
    if (sandbox) {
      log(`took sandbox ${sandbox.id} of ${sandbox.repo} at ${sandbox.commit} on ${name}, it had no changes`)
    } else {
      sandbox = await SandboxClient.create(connection, options.repo, options.ref)
      log(
        `created sandbox ${sandbox.id} of ${sandbox.repo} at ${sandbox.commit} on ${name}, ` +
          `set HAMMERKIT_SANDBOX=${sandbox.id} to come back to it`
      )
    }
  } else {
    throw new Error(
      'name a sandbox (HAMMERKIT_SANDBOX or --sandbox), or a repository and ref to create one from (HAMMERKIT_REPO and HAMMERKIT_REF, or --repo and --ref)'
    )
  }
  return new SandboxClient(connection, sandbox, { hash: build, shell: options.shell ?? DEFAULT_SHELL_TASK })
}

// A client that starts with a repository and ref takes a sandbox of the caller's of the same
// that nobody changed and no run holds, checked out at the ref again, rather than creating
// one on every start: sandboxes stay until they are deleted, and only a few are allowed.
async function reuseSandbox(connection: ServerConnection, repo: string, ref: string): Promise<SandboxView | undefined> {
  const build = { hash: '', shell: DEFAULT_SHELL_TASK }
  for (const candidate of await SandboxClient.list(connection)) {
    if (candidate.repo !== repo || candidate.ref !== ref || candidate.busy) {
      continue
    }
    const changes = await new SandboxClient(connection, candidate, build).changes()
    if (changes.files.length === 0) {
      return SandboxClient.fetch(connection, candidate.id, ref)
    }
  }
  return undefined
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
