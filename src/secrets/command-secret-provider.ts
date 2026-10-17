import { spawn } from 'child_process'
import { statSync } from 'fs'
import { delimiter, isAbsolute, resolve as resolvePath } from 'path'
import { Environment } from '../executer/environment'
import { AbortError } from '../executer/abort'
import type { SecretProvider, SecretProviderBinding } from './secret-provider'

const STDERR_LIMIT = 500

// Runs the provider's command and takes its stdout, verbatim, as the value: a
// key file needs its trailing newline. No shell, so a reference is one argument
// and never syntax. The command sees PATH, the provider's own `env` and the
// account's `env` and nothing else of this process: a personal login (`gcloud
// auth login`, the 1Password app) is never picked up, and a missing credential
// fails instead of falling back to one.
export function createCommandSecretProvider(binding: SecretProviderBinding): SecretProvider {
  return {
    async resolve(ref: string, environment: Environment): Promise<string> {
      const { command, args, env } = getProviderInvocation(binding, ref, environment)
      return run(
        command,
        args,
        { ...minimalEnvironment(environment), ...env },
        binding.definition.timeoutMs,
        environment
      )
    },
  }
}

/**
 * The command that reads `ref` as the account of the binding, and the variables of
 * the provider and the account it runs with: `${NAME}` filled from the environment,
 * `{{ref}}` as part of one argument. Without PATH, which is the machine's that runs it.
 */
export function getProviderInvocation(
  binding: SecretProviderBinding,
  ref: string,
  environment: Environment
): { command: string; args: string[]; env: { [key: string]: string } } {
  const { definition, account } = binding
  const [command, ...args] = definition.command.map((part) =>
    expand(part, environment, `provider ${definition.name}`).replace(/\{\{ref\}\}/g, () => ref)
  )
  return {
    command,
    args,
    env: {
      ...expandAll(definition.env, environment, `provider ${definition.name}`),
      ...expandAll(account.env, environment, `account ${account.name}, provider ${definition.name}`),
    },
  }
}

function minimalEnvironment(environment: Environment): { [key: string]: string } {
  const names = process.platform === 'win32' ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot'] : ['PATH']
  const result: { [key: string]: string } = {}
  for (const name of names) {
    const value = environment.processEnvs[name]
    if (value !== undefined && value !== null) {
      result[name] = value
    }
  }
  return result
}

function expandAll(
  values: { [key: string]: string },
  environment: Environment,
  owner: string
): { [key: string]: string } {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value, environment, owner)]))
}

// `${NAME}` from the process environment; one that is not set stops the secret
// before the command runs.
function expand(value: string, environment: Environment, owner: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = environment.processEnvs[name]
    if (resolved === undefined || resolved === null || resolved === '') {
      throw new Error(`${owner}: ${name} is not set`)
    }
    return resolved
  })
}

function run(
  command: string,
  args: string[],
  env: { [key: string]: string },
  timeoutMs: number,
  environment: Environment
): Promise<string> {
  return new Promise((resolve, reject) => {
    const signal = environment.abortCtrl.signal
    if (signal.aborted) {
      reject(new AbortError())
      return
    }

    const own = ownInvocation(command, args, env.PATH ?? env.Path)
    const child = spawn(own.command, own.args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let failure: Error | null = null

    const finish = (error: Error | null, value?: string) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error) {
        reject(error)
      } else {
        resolve(value ?? '')
      }
    }
    const stop = (error: Error) => {
      failure = failure ?? error
      child.kill('SIGKILL')
    }
    const onAbort = () => stop(new AbortError())
    const timer = setTimeout(() => stop(new Error(`${command} did not finish within ${timeoutMs}ms`)), timeoutMs)
    signal.addEventListener('abort', onAbort)

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' ? new Error(`${command} was not found on PATH`) : error)
    })
    child.on('close', (code) => {
      if (failure) {
        finish(failure)
      } else if (code !== 0) {
        finish(new Error(`${command} exited with code ${code}${describeStderr(stderr, environment)}`))
      } else {
        finish(null, Buffer.concat(stdout).toString('utf8'))
      }
    })
  })
}

export interface OwnBinary {
  // the path of this binary when it is a build of pkg, the release binary
  execPath: string | null
  // the script it starts its own commands with
  entry: string
}

const ownBinary: OwnBinary = {
  execPath: (process as { pkg?: unknown }).pkg ? process.execPath : null,
  entry: resolvePath(__dirname, '..', 'index.js'),
}

/**
 * A release binary (a build of pkg) gives every child PKG_EXECPATH, its own path,
 * and a child that is the same binary then starts as plain node, loading its first
 * argument as a script: `hammerkit github-app-token` as a provider fails with
 * "Cannot find module". So when the command is this binary, by any name on PATH, it
 * is started the way the server starts its workers: the entry script in front.
 */
export function ownInvocation(
  command: string,
  args: string[],
  path: string | undefined,
  self: OwnBinary = ownBinary
): { command: string; args: string[] } {
  if (self.execPath === null) {
    return { command, args }
  }
  const own = statOf(self.execPath)
  const found = candidates(command, path).find((candidate) => {
    const stat = statOf(candidate)
    return stat && own && stat.dev === own.dev && stat.ino === own.ino
  })
  return found ? { command: self.execPath, args: [self.entry, ...args] } : { command, args }
}

// where spawn looks for the command: a path as it is, a name in each directory of PATH
function candidates(command: string, path: string | undefined): string[] {
  const extensions =
    process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')] : ['']
  const bases =
    isAbsolute(command) || /[\\/]/.test(command)
      ? [resolvePath(command)]
      : (path ?? '')
          .split(delimiter)
          .filter((dir) => dir.length > 0)
          .map((dir) => resolvePath(dir, command))
  return bases.flatMap((base) => extensions.map((extension) => base + extension))
}

function statOf(path: string): { dev: number; ino: number } | null {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

// What the CLI said, as the first lines of a failure; its own output may hold a
// value it was asked for, so it is masked like all output.
function describeStderr(chunks: Buffer[], environment: Environment): string {
  const text = environment.secrets.redact(Buffer.concat(chunks).toString('utf8').trim())
  if (text.length === 0) {
    return ''
  }
  return `: ${text.length > STDERR_LIMIT ? `${text.substring(0, STDERR_LIMIT)}…` : text}`
}
