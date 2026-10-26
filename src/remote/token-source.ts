import { exec } from 'child_process'
import { Environment } from '../executer/environment'
import { getAccessToken } from './credentials'
import { RegisteredServer } from './host-config'

export interface TokenSource {
  token: () => Promise<string>
  // forgets the token, a token command runs again for the next one
  renew?: () => Promise<void>
}

// A bearer token is one word of visible ASCII; anything else is output of a token command
// that holds more than the token, which must never reach an error message.
export function isToken(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value)
}

// What a failed token command said on stderr, for the user's own terminal: never its stdout,
// and never in an error message, which a harness hands on to an agent.
const MAX_STDERR_LINES = 20
const MAX_STDERR_LINE = 300

function writeStderr(environment: Environment, what: string, stderr: string): void {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\x20-\x7e\t]/g, '?').slice(0, MAX_STDERR_LINE))
    .filter((line) => line.trim())
    .slice(-MAX_STDERR_LINES)
  for (const line of lines) {
    environment.stderr.write(`${what}: ${line}\n`)
  }
}

function commandSource(environment: Environment, command: string, what: string): TokenSource {
  let current: Promise<string> | undefined
  const run = () =>
    new Promise<string>((resolve, reject) => {
      exec(command, { env: environment.processEnvs, timeout: 60_000 }, (error, stdout, stderr) => {
        const token = String(stdout).trim()
        if (error || !token) {
          writeStderr(environment, what, String(stderr))
          const status = error?.killed
            ? ', it did not end within a minute'
            : typeof error?.code === 'number'
              ? `, it exited with ${error.code}`
              : ''
          reject(new Error(`${what} printed no token${status}`))
        } else if (!isToken(token)) {
          // never the output itself: it can hold more secrets than the token
          reject(new Error(`${what} printed more than a token, it has to print the token alone`))
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

/**
 * The token a client of a server sends: a harness, and the `remote` commands. In this order:
 *
 * - `HAMMERKIT_TOKEN_COMMAND`: a command that prints a short-lived token of the agent's own
 *   identity, such as a workload identity or a service account of the identity provider. It
 *   runs again when the server no longer accepts the token.
 * - `HAMMERKIT_TOKEN`: such a token, as the agent's platform hands it over.
 * - the token command of the server in the host config (`remote add --token-command`): the
 *   same as `HAMMERKIT_TOKEN_COMMAND`, for one server, so each server can have the service
 *   account and audience it accepts. It only ever comes from the host config, never from a
 *   build file: whoever writes it decides what runs on this machine.
 * - the sign-in of `hammerkit remote login <server>`.
 *
 * The token only goes to the URL the server is registered with in the host config.
 */
export function getTokenSource(
  environment: Environment,
  name: string,
  server: Pick<RegisteredServer, 'url' | 'issuer' | 'tokenCommand'>
): TokenSource {
  // a variable holds for every server: say so when it takes the place of the one registered
  const overrides = (variable: string) => {
    if (server.tokenCommand) {
      environment.stderr.write(`${variable} is set, so the token command of ${name} is not used\n`)
    }
  }
  const command = environment.processEnvs.HAMMERKIT_TOKEN_COMMAND
  if (command) {
    overrides('HAMMERKIT_TOKEN_COMMAND')
    return commandSource(environment, command, 'HAMMERKIT_TOKEN_COMMAND')
  }
  const fixed = environment.processEnvs.HAMMERKIT_TOKEN?.trim()
  if (fixed) {
    overrides('HAMMERKIT_TOKEN')
    return {
      token: async () => {
        if (!isToken(fixed)) {
          throw new Error('HAMMERKIT_TOKEN holds more than a token, it has to be the token alone')
        }
        return fixed
      },
    }
  }
  if (server.tokenCommand) {
    return commandSource(environment, server.tokenCommand, `the token command of ${name}`)
  }
  return { token: () => getAccessToken(environment, name, server) }
}
