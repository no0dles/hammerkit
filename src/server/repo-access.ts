import { devNull } from 'os'
import { Environment } from '../executer/environment'
import { createSecretRegistry } from '../utils/redact'
import { fetchProviderValue } from '../secrets/provider-values'
import { SecretCatalog } from '../secrets/secret-catalog'
import { resolveRef } from './git-checkout'
import { matchesAnyRepo } from './repo'
import { ServerConfig, Source } from './server-config'

// A token is read again after this long, so a short-lived one (a GitHub App
// installation token minted by the provider command) is not used up and a revoked one
// stops working soon.
const TOKEN_TTL_MS = 60 * 1000

// A run waits for the repository at submit, not forever
const RESOLVE_TIMEOUT_MS = 30 * 1000

export interface RepoAccessOptions {
  // where a repository is fetched from; `https://<host>/<path>.git` when left out
  url?: (repo: string) => string
  // how a ref is resolved to a commit; `git ls-remote` when left out
  resolve?: (repo: string, ref: string, signal: AbortSignal) => Promise<string>
  now?: () => number
}

/**
 * The repositories a server can run code from. What may be read is the operator's
 * `sources` list; who may name which of them is the entitlement's `repos`. The read
 * credential is a secret of a provider, read as a service account that nobody can use
 * in a task. It is handed to git for one fetch through the environment of that git
 * process (never an argument, never `.git/config`, never the environment of a task)
 * and masked in whatever the run logs.
 */
export class RepoAccess {
  private readonly tokens = new Map<string, { value: string; at: number }>()
  private readonly now: () => number

  constructor(
    private readonly config: Pick<ServerConfig, 'sources'>,
    // the base environment of the server's runs, with `hosted` set
    private readonly environment: Environment,
    private readonly options: RepoAccessOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  // The first source that covers the repository: patterns are listed from the most
  // specific to the least.
  source(repo: string): Source | undefined {
    return this.config.sources.find((source) => matchesAnyRepo([source.match], repo))
  }

  readable(repo: string): boolean {
    return this.source(repo) !== undefined
  }

  url(repo: string): string {
    return this.options.url ? this.options.url(repo) : `https://${repo}.git`
  }

  // The commit a ref points to now, or an error that says what is wrong with the ref.
  async resolve(repo: string, ref: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
    if (this.options.resolve) {
      return this.options.resolve(repo, ref, abort)
    }
    const credentials = await this.credentials(repo)
    try {
      return await resolveRef(this.url(repo), ref, credentials.env, abort)
    } catch (e) {
      throw this.scrub(e, credentials.values)
    }
  }

  /**
   * The environment a git process needs to read the repository: the allowlisted
   * variables of the server, and the token as a header of requests to that host. The
   * values are what the run has to mask.
   */
  async credentials(repo: string): Promise<{ env: { [key: string]: string }; values: string[] }> {
    return this.withSecret(repo, this.source(repo)?.secret)
  }

  /**
   * The same for pushing a sandbox to the repository, with the write credential of the
   * source's `push`, which is a secret and an account of its own: a server that only reads
   * never holds a token that writes.
   */
  async pushCredentials(repo: string): Promise<{ env: { [key: string]: string }; values: string[] }> {
    const secret = this.source(repo)?.push?.secret
    if (!secret) {
      throw new Error(`this server does not push to ${repo}`)
    }
    const credentials = await this.withSecret(repo, secret)
    // nothing but that token: no configuration, credential helper, .netrc or ssh agent of
    // the server's user, which would push as whoever that user is
    const env = { ...credentials.env }
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH_COMMAND']) {
      delete env[key]
    }
    const count = Number(env.GIT_CONFIG_COUNT ?? '0')
    env[`GIT_CONFIG_KEY_${count}`] = 'credential.helper'
    env[`GIT_CONFIG_VALUE_${count}`] = ''
    env.GIT_CONFIG_COUNT = String(count + 1)
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_CONFIG_GLOBAL = devNull
    return { env, values: credentials.values }
  }

  private async withSecret(
    repo: string,
    secret: Source['secret']
  ): Promise<{ env: { [key: string]: string }; values: string[] }> {
    const env: { [key: string]: string } = {}
    for (const [key, value] of Object.entries(this.environment.processEnvs)) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    if (!secret) {
      return { env, values: [] }
    }
    const token = await this.token(secret)
    const host = repo.split('/')[0]
    const header = `Authorization: Basic ${Buffer.from(`${secret.username}:${token}`).toString('base64')}`
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = `http.https://${host}/.extraHeader`
    env.GIT_CONFIG_VALUE_0 = header
    return { env, values: [token, header] }
  }

  private async token(secret: NonNullable<Source['secret']>): Promise<string> {
    const key = `${secret.account}\0${secret.from}`
    const known = this.tokens.get(key)
    if (known && this.now() - known.at < TOKEN_TTL_MS) {
      return known.value
    }
    const catalog = this.environment.hosted?.catalog as SecretCatalog
    const kind = secret.from.substring(0, secret.from.indexOf(':'))
    const ref = secret.from.substring(secret.from.indexOf(':') + 1)
    const provider = catalog.providers[kind]
    const account = catalog.accounts[secret.account]
    const credentials = account?.providers[kind]
    if (!provider || !credentials) {
      throw new Error(`the source credential ${secret.from} as ${secret.account} is not defined`)
    }
    // a fresh environment per read: values are kept here and for a short time only
    const registry = createSecretRegistry()
    const environment: Environment = {
      ...this.environment,
      secrets: registry,
      hosted: { catalog, accounts: [secret.account] },
    }
    let value: string
    try {
      value = await fetchProviderValue(
        { definition: provider, account: { name: secret.account, env: credentials.env } },
        ref,
        environment
      )
    } catch (e) {
      throw new Error(`could not read the source credential ${secret.from}: ${e instanceof Error ? e.message : e}`)
    }
    if (value.length === 0) {
      throw new Error(`the source credential ${secret.from} is empty`)
    }
    this.tokens.set(key, { value, at: this.now() })
    return value
  }

  // An error as the caller may read it: without the token.
  scrub(error: unknown, values: string[]): Error {
    const registry = createSecretRegistry()
    values.forEach((value) => registry.register(value))
    const message = error instanceof Error ? error.message : String(error)
    const scrubbed = new (error instanceof Error ? (error.constructor as new (m: string) => Error) : Error)(
      registry.redact(message)
    )
    return scrubbed
  }
}
