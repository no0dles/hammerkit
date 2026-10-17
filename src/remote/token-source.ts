import { exec } from 'child_process'
import { Environment } from '../executer/environment'
import { getAccessToken } from './credentials'

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

/**
 * The token a client of a server sends: a harness, and the `remote` commands. In this order:
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
): TokenSource {
  const command = environment.processEnvs.HAMMERKIT_TOKEN_COMMAND
  if (command) {
    let current: Promise<string> | undefined
    const run = () =>
      new Promise<string>((resolve, reject) => {
        exec(command, { env: environment.processEnvs, timeout: 60_000 }, (error, stdout) => {
          const token = String(stdout).trim()
          if (error || !token) {
            reject(new Error('HAMMERKIT_TOKEN_COMMAND printed no token'))
          } else if (!isToken(token)) {
            // never the output itself: it can hold more secrets than the token
            reject(new Error('HAMMERKIT_TOKEN_COMMAND printed more than a token, it has to print the token alone'))
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
  const fixed = environment.processEnvs.HAMMERKIT_TOKEN?.trim()
  if (fixed) {
    return {
      token: async () => {
        if (!isToken(fixed)) {
          throw new Error('HAMMERKIT_TOKEN holds more than a token, it has to be the token alone')
        }
        return fixed
      },
    }
  }
  return { token: () => getAccessToken(environment, name, server) }
}
