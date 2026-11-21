import { createHash } from 'crypto'
import { homedir } from 'os'
import { existsSync, readFileSync } from 'fs'
import { Environment } from '../executer/environment'
import { BuildFileSecretSchema } from '../schema/build-file-secret-schema'
import { normalizePath } from './utils/normalize-path'
import { templateValue } from './utils/template-value'
import { WorkEnvironmentVariables } from '../environment/replace-env-variables'
import { portablePath } from './utils/portable-path'
import { AbortError } from '../executer/abort'
import { declared, SecretAccountDefinition, SecretCatalog } from '../secrets/secret-catalog'
import { SecretProviderBinding } from '../secrets/secret-provider'
import { fetchProviderValue, peekProviderValue } from '../secrets/provider-values'

export type WorkSecretSource =
  | { type: 'env'; name: string }
  | { type: 'file'; path: string }
  | { type: 'provider'; provider: string; ref: string; account: string; binding: SecretProviderBinding }
  // a provider secret this machine can't read: its provider or account is not declared here,
  // or the account has no credentials for the provider. It fails only the run of a task or
  // service that reads it (requireReadableSecrets), the other tasks of the file plan and run.
  | { type: 'unavailable'; from: string; reason: string; error: string }
export type WorkSecretTarget = { type: 'env'; name: string } | { type: 'file'; path: string }

export interface WorkSecret {
  source: WorkSecretSource
  target: WorkSecretTarget
  // a salted digest of the value is part of the task's cache key; computed
  // only when the task's id is, so tasks outside the run never need the value
  cache: boolean
  digest: () => string
}

// Where the value comes from, for messages and for what makes a service
// different: never the value.
export function describeSecretSource(secret: WorkSecret): string {
  const source = secret.source
  if (source.type === 'provider') {
    return `${source.provider}:${source.ref} as ${source.account}`
  }
  if (source.type === 'unavailable') {
    return source.from
  }
  return source.type === 'env' ? `env:${source.name}` : `file:${source.path}`
}

// What a task or service reads that this machine can't, one line each, for `ls` and `validate`
export function getUnreadableSecrets(secrets: WorkSecret[]): string[] {
  return secrets.flatMap((secret) => (secret.source.type === 'unavailable' ? [secret.source.reason] : []))
}

export function getSecretName(secret: WorkSecret): string {
  return secret.target.type === 'env' ? secret.target.name : secret.target.path
}

// The name as it reads on every checkout, for cache identity: a file target
// lives under the task's cwd, which is a different absolute path per machine.
export function getPortableSecretName(projectRoot: string, secret: WorkSecret): string {
  return secret.target.type === 'env' ? secret.target.name : portablePath(projectRoot, secret.target.path)
}

export function parseWorkSecrets(
  cwd: string,
  projectRoot: string,
  secrets: BuildFileSecretSchema[] | undefined,
  envs: WorkEnvironmentVariables,
  environment: Environment,
  catalog: SecretCatalog,
  // what the secrets belong to, for messages: `task build` or `service db`
  owner: string,
  // the service account of the task or service the secrets belong to
  account?: string
): WorkSecret[] {
  return (secrets ?? []).map((secret) => {
    const ref = secret.from.substring(secret.from.indexOf(':') + 1)
    const target: WorkSecretTarget = secret.env
      ? { type: 'env', name: secret.env }
      : { type: 'file', path: normalizePath(cwd, cwd, templateValue(secret.path ?? '', envs)) }
    const name = target.type === 'env' ? target.name : secret.path
    const source = parseSecretSource(secret, ref, cwd, envs, catalog, account, owner, `secret ${name}`)
    const workSecret: WorkSecret = {
      source,
      target,
      cache: secret.cache ?? false,
      digest: () => getSecretDigest(projectRoot, cwd, workSecret, readSecretValueSync(workSecret, environment)),
    }
    return workSecret
  })
}

function parseSecretSource(
  secret: BuildFileSecretSchema,
  ref: string,
  cwd: string,
  envs: WorkEnvironmentVariables,
  catalog: SecretCatalog,
  taskAccount: string | undefined,
  owner: string,
  label: string
): WorkSecretSource {
  const kind = secret.from.substring(0, secret.from.indexOf(':'))
  if (kind === 'env') {
    return { type: 'env', name: ref }
  }
  if (kind === 'file') {
    return { type: 'file', path: normalizePath(cwd, homedir(), templateValue(ref, envs)) }
  }

  const reads = `${owner} reads ${label} from ${secret.from}`
  // what the build file gets wrong fails it as a whole; what this machine does not declare
  // fails only a run that reads the secret
  const providerRef = templateValue(ref, envs)
  if (providerRef.length === 0 || providerRef.startsWith('-')) {
    throw new Error(`${reads}: a reference for ${kind} must not be empty or start with -`)
  }
  const unavailable = (reason: string, error: string): WorkSecretSource => ({
    type: 'unavailable',
    from: secret.from,
    reason: `${label} from ${secret.from}: ${reason}`,
    error,
  })
  const server = !!catalog.explicitAccounts
  const provider = declared(catalog.providers, kind)
  if (!provider) {
    return unavailable(
      server ? `this server has no secret provider ${kind}` : `no secret provider ${kind} is declared`,
      unknownProviderMessage(catalog, reads, kind)
    )
  }
  const accountName = catalog.explicitAccounts
    ? secret.account
    : secret.account ?? taskAccount ?? Object.values(catalog.accounts).find((a) => a.default)?.name
  if (!accountName) {
    return unavailable(
      server ? 'it names no account' : 'no account is named and none is the default',
      missingAccountMessage(catalog, reads, owner)
    )
  }
  const account = declared(catalog.accounts, accountName)
  if (!account) {
    const namedBy = secret.account ? 'the account: of the secret' : `the account: of ${owner}`
    return unavailable(
      server ? `this server has no account ${accountName}` : `no account ${accountName} is declared`,
      unknownAccountMessage(catalog, reads, owner, accountName, namedBy, kind)
    )
  }
  const credentials = declared(account.providers, kind)
  if (!credentials) {
    return unavailable(
      `account ${accountName} has no credentials for ${kind}`,
      missingCredentialsMessage(catalog, reads, account, kind)
    )
  }
  return {
    type: 'provider',
    provider: kind,
    ref: providerRef,
    account: accountName,
    binding: { definition: provider, account: { name: accountName, env: credentials.env } },
  }
}

// The messages below say what is wrong, where the names come from and what to write: a
// person who only ran a task should not need to know how secrets are declared. On a
// server the build file can only change what it names, the operator declares the rest.

const SECRET_PROVIDERS_DOCS = 'https://hammerkit.dev/docs/task/secret-providers'

// `tests, dev in ~/.hammerkit/config.yaml and ci in .hammerkit.yaml`, or `none`
function listDeclared(definitions: { name: string; declaredIn: string }[], server: boolean): string {
  if (definitions.length === 0) {
    return 'none'
  }
  if (server) {
    return definitions.map((d) => d.name).join(', ')
  }
  const byFile = new Map<string, string[]>()
  for (const definition of definitions) {
    byFile.set(definition.declaredIn, [...(byFile.get(definition.declaredIn) ?? []), definition.name])
  }
  return [...byFile.entries()].map(([file, names]) => `${names.join(', ')} in ${file}`).join(' and ')
}

// Only a run that reads the secret fails: the other tasks of the build file run.
function seeDocs(anchor: string): string {
  return `See ${SECRET_PROVIDERS_DOCS}#${anchor}`
}

function hostConfigOf(catalog: SecretCatalog): string {
  return catalog.hostConfig ?? 'the host config'
}

function indent(lines: string[]): string {
  return lines.map((line) => `  ${line}`).join('\n')
}

// A variable of this machine to hold the credential, for snippets: `${OPERATOR_CREDENTIALS}`
function credentialVariable(account: string, key: string, keys: number): string {
  const prefix = account.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `\${${prefix}_${keys === 1 ? 'CREDENTIALS' : key}}`
}

// The credential variables a provider's command reads, as another account passes them;
// a placeholder when no account has credentials for the provider yet
function credentialLines(catalog: SecretCatalog, account: string, provider: string): string[] {
  const sibling = Object.values(catalog.accounts).find((a) => declared(a.providers, provider))
  const keys = sibling ? Object.keys(sibling.providers[provider].env) : []
  if (keys.length === 0) {
    return [`<VARIABLE>: \${<VARIABLE OF THIS MACHINE>} # what ${provider} reads its credential from`]
  }
  return keys.map((key) => `${key}: ${credentialVariable(account, key, keys.length)}`)
}

function unknownProviderMessage(catalog: SecretCatalog, reads: string, kind: string): string {
  const declaredProviders = listDeclared(Object.values(catalog.providers), !!catalog.explicitAccounts)
  if (catalog.explicitAccounts) {
    return (
      `${reads}, but this server has no secret provider ${kind} (it has: ${declaredProviders}). ` +
      `Use one of its providers, or ask the operator of the server to add ${kind} to its config.`
    )
  }
  return [
    `${reads}, but no secret provider ${kind} is declared (declared: ${declaredProviders}).`,
    `A provider is the command that prints a secret's value. Declare it in the host config, ${hostConfigOf(catalog)}:`,
    '',
    indent(['secretProviders:', `  ${kind}:`, `    command: [<command>, <its arguments>, '{{ref}}']`]),
    '',
    seeDocs('providers'),
  ].join('\n')
}

function missingAccountMessage(catalog: SecretCatalog, reads: string, owner: string): string {
  const declaredAccounts = listDeclared(Object.values(catalog.accounts), !!catalog.explicitAccounts)
  if (catalog.explicitAccounts) {
    return (
      `${reads}, but names no account. A server reads every secret as the account the secret names, ` +
      `never as the account of a task or a default: add account: to the secret (this server has: ${declaredAccounts}).`
    )
  }
  return [
    `${reads}, but neither the secret nor ${owner} names an account, and no account is marked default: true (declared: ${declaredAccounts}).`,
    `An account says which credential a secret is read with. Name one with account: on the secret or on ${owner}, ` +
      `or mark one as the default in ${hostConfigOf(catalog)}:`,
    '',
    indent(['secretAccounts:', '  <account>:', '    default: true']),
    '',
    seeDocs('accounts'),
  ].join('\n')
}

function unknownAccountMessage(
  catalog: SecretCatalog,
  reads: string,
  owner: string,
  account: string,
  namedBy: string,
  provider: string
): string {
  const declaredAccounts = listDeclared(Object.values(catalog.accounts), !!catalog.explicitAccounts)
  if (catalog.explicitAccounts) {
    return (
      `${reads} as account ${account}, but this server has no account ${account} (it has: ${declaredAccounts}). ` +
      `Name one of its accounts with account: on the secret, or ask the operator of the server to add ${account} to its config.`
    )
  }
  return [
    `${reads} as account ${account} (${namedBy}), but no account ${account} is declared (declared: ${declaredAccounts}).`,
    `An account says which credential a secret is read with, and each machine declares its own in its host config, ` +
      `${hostConfigOf(catalog)}. Add ${account} there:`,
    '',
    indent([
      'secretAccounts:',
      `  ${account}:`,
      '    providers:',
      `      ${provider}:`,
      '        env:',
      ...credentialLines(catalog, account, provider).map((line) => `          ${line}`),
    ]),
    '',
    `Or read the secret as one of the declared accounts with account: on the secret${
      namedBy === 'the account: of the secret' ? '' : ` or on ${owner}`
    }.`,
    seeDocs('accounts'),
  ].join('\n')
}

function missingCredentialsMessage(
  catalog: SecretCatalog,
  reads: string,
  account: SecretAccountDefinition,
  provider: string
): string {
  if (catalog.explicitAccounts) {
    return (
      `${reads} as account ${account.name}, but that account of this server has no credentials for ${provider}. ` +
      `Ask the operator of the server to add them to its config.`
    )
  }
  return [
    `${reads} as account ${account.name}, but account ${account.name} (in ${account.declaredIn}) has no credentials for provider ${provider}.`,
    `Add the variables that make ${provider} act as ${account.name}:`,
    '',
    indent([
      'secretAccounts:',
      `  ${account.name}:`,
      '    providers:',
      `      ${provider}:`,
      '        env:',
      ...credentialLines(catalog, account.name, provider).map((line) => `          ${line}`),
    ]),
    '',
    seeDocs('accounts'),
  ].join('\n')
}

function readSecretValueSync(secret: WorkSecret, environment: Environment): string {
  if (secret.source.type === 'unavailable') {
    throw new Error(secret.source.error)
  }
  if (secret.source.type === 'env') {
    const value = environment.processEnvs[secret.source.name]
    if (value === undefined || value === null) {
      throw new Error(`secret ${getSecretName(secret)}: environment variable ${secret.source.name} is not set`)
    }
    environment.secrets.register(value)
    return value
  }
  if (secret.source.type === 'provider') {
    const value = peekProviderValue(secret.source.binding, secret.source.ref, environment)
    if (value === undefined) {
      throw new Error(
        `secret ${getSecretName(secret)}: ${describeSecretSource(
          secret
        )} was not fetched before its task id was computed`
      )
    }
    environment.secrets.register(value)
    return value
  }
  if (!existsSync(secret.source.path)) {
    throw new Error(`secret ${getSecretName(secret)}: file ${secret.source.path} does not exist`)
  }
  const value = readFileSync(secret.source.path, 'utf8')
  environment.secrets.register(value)
  return value
}

// The value, read when the task or service starts (or when a cache-affecting
// secret is hashed); a missing source fails naming the secret.
export async function resolveSecretValue(secret: WorkSecret, environment: Environment): Promise<string> {
  if (secret.source.type === 'unavailable') {
    throw new Error(secret.source.error)
  }
  if (secret.source.type === 'env') {
    const value = environment.processEnvs[secret.source.name]
    if (value === undefined || value === null) {
      throw new Error(`secret ${getSecretName(secret)}: environment variable ${secret.source.name} is not set`)
    }
    environment.secrets.register(value)
    return value
  }
  if (secret.source.type === 'provider') {
    return resolveProviderSecret(secret, secret.source, environment)
  }
  if (!(await environment.file.exists(secret.source.path))) {
    throw new Error(`secret ${getSecretName(secret)}: file ${secret.source.path} does not exist`)
  }
  const value = await environment.file.read(secret.source.path)
  environment.secrets.register(value)
  return value
}

// Salted with the project-relative location and the secret's name, so the
// digest is identical on every checkout (remote cache ids match) but can't be
// matched against digests of the same value elsewhere.
export function getSecretDigest(projectRoot: string, cwd: string, secret: WorkSecret, value: string): string {
  const salt = `hammerkit-secret\0${portablePath(projectRoot, cwd)}\0${getPortableSecretName(projectRoot, secret)}`
  return `sha256:${createHash('sha256').update(`${salt}\0${value}`).digest('hex')}`
}

async function resolveProviderSecret(
  secret: WorkSecret,
  source: Extract<WorkSecretSource, { type: 'provider' }>,
  environment: Environment
): Promise<string> {
  let value: string
  try {
    value = await fetchProviderValue(source.binding, source.ref, environment)
  } catch (error) {
    if (error instanceof AbortError) {
      throw error
    }
    throw new Error(
      `secret ${getSecretName(secret)} (${describeSecretSource(secret)}): ${
        error instanceof Error ? error.message : error
      }`
    )
  }
  if (value.length === 0) {
    throw new Error(`secret ${getSecretName(secret)} (${describeSecretSource(secret)}): the provider returned no value`)
  }
  environment.secrets.register(value)
  return value
}
