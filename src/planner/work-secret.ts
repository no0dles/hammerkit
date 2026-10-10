import { createHash } from 'crypto'
import { homedir } from 'os'
import { existsSync, readFileSync } from 'fs'
import { Environment } from '../executer/environment'
import { BuildFileSecretSchema } from '../schema/build-file-secret-schema'
import { normalizePath } from './utils/normalize-path'
import { templateValue } from './utils/template-value'
import { WorkEnvironmentVariables } from '../environment/replace-env-variables'
import { portablePath } from './utils/portable-path'

export type WorkSecretSource = { type: 'env'; name: string } | { type: 'file'; path: string }
export type WorkSecretTarget = { type: 'env'; name: string } | { type: 'file'; path: string }

export interface WorkSecret {
  source: WorkSecretSource
  target: WorkSecretTarget
  // a salted digest of the value is part of the task's cache key; computed
  // only when the task's id is, so tasks outside the run never need the value
  cache: boolean
  digest: () => string
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
  environment: Environment
): WorkSecret[] {
  return (secrets ?? []).map((secret) => {
    const ref = secret.from.substring(secret.from.indexOf(':') + 1)
    const source: WorkSecretSource = secret.from.startsWith('env:')
      ? { type: 'env', name: ref }
      : { type: 'file', path: normalizePath(cwd, homedir(), templateValue(ref, envs)) }
    const target: WorkSecretTarget = secret.env
      ? { type: 'env', name: secret.env }
      : { type: 'file', path: normalizePath(cwd, cwd, templateValue(secret.path ?? '', envs)) }
    const workSecret: WorkSecret = {
      source,
      target,
      cache: secret.cache ?? false,
      digest: () => getSecretDigest(projectRoot, cwd, workSecret, readSecretValueSync(workSecret, environment)),
    }
    return workSecret
  })
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
