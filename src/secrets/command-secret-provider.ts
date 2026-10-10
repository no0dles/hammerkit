import { spawn } from 'child_process'
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
  const { definition, account } = binding

  return {
    async resolve(ref: string, environment: Environment): Promise<string> {
      const [command, ...args] = definition.command.map((part) =>
        expand(part, environment, `provider ${definition.name}`).replace(/\{\{ref\}\}/g, () => ref)
      )
      const env = {
        ...minimalEnvironment(environment),
        ...expandAll(definition.env, environment, `provider ${definition.name}`),
        ...expandAll(account.env, environment, `account ${account.name}, provider ${definition.name}`),
      }
      return run(command, args, env, definition.timeoutMs, environment)
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

    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

// What the CLI said, as the first lines of a failure; its own output may hold a
// value it was asked for, so it is masked like all output.
function describeStderr(chunks: Buffer[], environment: Environment): string {
  const text = environment.secrets.redact(Buffer.concat(chunks).toString('utf8').trim())
  if (text.length === 0) {
    return ''
  }
  return `: ${text.length > STDERR_LIMIT ? `${text.substring(0, STDERR_LIMIT)}…` : text}`
}
