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
import { SecretCatalog } from '../secrets/secret-catalog'
import { SecretProviderBinding } from '../secrets/secret-provider'
import { fetchProviderValue, peekProviderValue } from '../secrets/provider-values'

export type WorkSecretSource =
  | { type: 'env'; name: string }
  | { type: 'file'; path: string }
  | { type: 'provider'; provider: string; ref: string; account: string; binding: SecretProviderBinding }
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
  return source.type === 'env' ? `env:${source.name}` : `file:${source.path}`
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
  // the service account of the task or service the secrets belong to
  account?: string
): WorkSecret[] {
  return (secrets ?? []).map((secret) => {
    const ref = secret.from.substring(secret.from.indexOf(':') + 1)
    const target: WorkSecretTarget = secret.env
      ? { type: 'env', name: secret.env }
      : { type: 'file', path: normalizePath(cwd, cwd, templateValue(secret.path ?? '', envs)) }
    const name = target.type === 'env' ? target.name : secret.path
    const source = parseSecretSource(secret, ref, cwd, envs, catalog, account, `secret ${name}`)
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
  label: string
): WorkSecretSource {
  const kind = secret.from.substring(0, secret.from.indexOf(':'))
  if (kind === 'env') {
    return { type: 'env', name: ref }
  }
  if (kind === 'file') {
    return { type: 'file', path: normalizePath(cwd, homedir(), templateValue(ref, envs)) }
  }

  const provider = catalog.providers[kind]
  if (!provider) {
    const declared = Object.keys(catalog.providers)
    throw new Error(
      `${label}: unknown secret provider ${kind}, ${
        declared.length > 0 ? `declared: ${declared.join(', ')}` : 'none is declared'
      }`
    )
  }
  const providerRef = templateValue(ref, envs)
  if (providerRef.length === 0 || providerRef.startsWith('-')) {
    throw new Error(`${label}: a reference for ${kind} must not be empty or start with -`)
  }
  const accountName = secret.account ?? taskAccount ?? Object.values(catalog.accounts).find((a) => a.default)?.name
  if (!accountName) {
    throw new Error(`${label}: ${kind}:${providerRef} needs an account, and none is named or marked default: true`)
  }
  const account = catalog.accounts[accountName]
  if (!account) {
    throw new Error(
      `${label}: unknown secret account ${accountName}, declared: ${Object.keys(catalog.accounts).join(', ') || 'none'}`
    )
  }
  const credentials = account.providers[kind]
  if (!credentials) {
    throw new Error(`${label}: account ${accountName} has no credentials for provider ${kind}`)
  }
  return {
    type: 'provider',
    provider: kind,
    ref: providerRef,
    account: accountName,
    binding: { definition: provider, account: { name: accountName, env: credentials.env } },
  }
}

function readSecretValueSync(secret: WorkSecret, environment: Environment): string {
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
