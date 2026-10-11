import { Environment } from '../executer/environment'
import { mergeEnvironmentVariables } from '../environment/merge-environment-variables'
import { buildEnvironmentVariables } from '../environment/replace-env-variables'
import { ReferencedContext } from '../schema/reference-parser'
import { ParseScope } from '../schema/parse-context'
import { parseDuration } from '../utils/units'

const DEFAULT_TIMEOUT = '30s'

// A provider as declared: how to fetch (ADR 0008). The command already has the
// declaring file's `envs` applied (its inputs); `${HOST_VARIABLE}` references
// left in it are filled from the process environment when a secret is read.
export interface SecretProviderDefinition {
  name: string
  type: 'command'
  command: string[]
  env: { [key: string]: string }
  timeoutMs: number
  declaredIn: string
}

export interface SecretAccountDefinition {
  name: string
  default: boolean
  // per provider, the environment that makes its command act as this account;
  // values are `${HOST_VARIABLE}` references
  providers: { [provider: string]: { env: { [key: string]: string } } }
  declaredIn: string
}

export interface SecretCatalog {
  providers: { [name: string]: SecretProviderDefinition }
  accounts: { [name: string]: SecretAccountDefinition }
}

export function emptySecretCatalog(): SecretCatalog {
  return { providers: {}, accounts: {} }
}

const FULL_COMMIT = /^[0-9a-f]{40}$/i

// Providers and accounts are global names, like caches, collected from every
// loaded build file. A name declared twice is an error rather than a silent
// override: which definition runs with a service account's credential must not
// depend on include order.
export function collectSecretCatalog(
  files: ParseScope[],
  environment: Environment,
  context: ReferencedContext
): SecretCatalog {
  const catalog = emptySecretCatalog()

  for (const file of files) {
    const providers = Object.entries(file.schema.secretProviders ?? {})
    const accounts = Object.entries(file.schema.secretAccounts ?? {})
    if (providers.length === 0 && accounts.length === 0) {
      continue
    }
    requirePinnedSource(file)

    const envs = buildEnvironmentVariables(
      mergeEnvironmentVariables(file.schema.envs, null),
      environment,
      context
    ).variables
    for (const [name, provider] of providers) {
      if (catalog.providers[name]) {
        throw new Error(
          `secret provider ${name} is declared in ${catalog.providers[name].declaredIn} and in ${file.fileName}`
        )
      }
      catalog.providers[name] = {
        name,
        type: 'command',
        command: provider.command.map((part) => applyEnvs(part, envs)),
        env: provider.env ?? {},
        timeoutMs: parseDuration(provider.timeout ?? DEFAULT_TIMEOUT),
        declaredIn: file.fileName,
      }
    }
    for (const [name, account] of accounts) {
      if (catalog.accounts[name]) {
        throw new Error(
          `secret account ${name} is declared in ${catalog.accounts[name].declaredIn} and in ${file.fileName}`
        )
      }
      catalog.accounts[name] = {
        name,
        default: account.default ?? false,
        providers: account.providers,
        declaredIn: file.fileName,
      }
    }
  }

  const defaults = Object.values(catalog.accounts).filter((account) => account.default)
  if (defaults.length > 1) {
    throw new Error(`more than one default secret account: ${defaults.map((a) => a.name).join(', ')}`)
  }
  for (const account of Object.values(catalog.accounts)) {
    for (const provider of Object.keys(account.providers)) {
      if (!catalog.providers[provider]) {
        throw new Error(
          `secret account ${account.name} (${account.declaredIn}) names provider ${provider}, which is not declared`
        )
      }
    }
  }
  return catalog
}

// A tag or branch can be moved, and a moved file runs with the credentials of a
// service account: providers and accounts from a git include are pinned.
function requirePinnedSource(file: ParseScope) {
  if (file.remote && !FULL_COMMIT.test(file.remote.ref ?? '')) {
    throw new Error(
      `${file.fileName} declares secret providers or accounts, so its git include ${file.remote.git} needs ref to be a full commit SHA`
    )
  }
}

// `${NAME}` that the build file's own `envs` define; any other reference stays
// for the host environment.
function applyEnvs(value: string, envs: { [key: string]: string }): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    name in envs && !envs[name].includes('$') ? envs[name] : match
  )
}
