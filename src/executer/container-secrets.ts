import { join } from 'path'
import { chmod, mkdir, rm, writeFile } from 'fs/promises'
import { Environment } from './environment'
import { WorkSecret, getSecretName, resolveSecretValue } from '../planner/work-secret'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { convertToPosixPath } from './execute-docker'

export interface ContainerSecrets {
  // env targets, merged into the container's environment
  env: { [name: string]: string }
  // read-only binds for file targets
  binds: string[]
}

// Where values of env-sourced file targets are written while their container
// runs: owner-only, outside the project, removed with the container.
export function getSecretDirectory(instanceId: string): string {
  return join(getHammerkitDirectory(), 'secrets', instanceId)
}

// Resolve every secret before the container starts, so a missing source fails
// naming the secret and nothing has run yet.
export async function prepareContainerSecrets(
  secrets: WorkSecret[],
  instanceId: string,
  environment: Environment
): Promise<ContainerSecrets> {
  const result: ContainerSecrets = { env: {}, binds: [] }
  for (const secret of secrets) {
    if (secret.target.type === 'env') {
      result.env[secret.target.name] = await resolveSecretValue(secret, environment)
      continue
    }
    if (secret.source.type === 'file') {
      await resolveSecretValue(secret, environment)
      result.binds.push(`${secret.source.path}:${convertToPosixPath(secret.target.path)}:ro`)
      continue
    }
    const directory = getSecretDirectory(instanceId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const file = join(directory, getSecretFileName(secret))
    await writeFile(file, await resolveSecretValue(secret, environment), { mode: 0o600 })
    // the mode only applies on create, a leftover file is tightened too
    await chmod(file, 0o600)
    result.binds.push(`${file}:${convertToPosixPath(secret.target.path)}:ro`)
  }
  return result
}

// A local task only takes env targets, file targets are refused when planning.
export async function resolveSecretEnvs(
  secrets: WorkSecret[],
  environment: Environment
): Promise<{ [name: string]: string }> {
  const envs: { [name: string]: string } = {}
  for (const secret of secrets) {
    if (secret.target.type === 'env') {
      envs[secret.target.name] = await resolveSecretValue(secret, environment)
    }
  }
  return envs
}

export async function removeContainerSecrets(instanceId: string): Promise<void> {
  await rm(getSecretDirectory(instanceId), { recursive: true, force: true })
}

function getSecretFileName(secret: WorkSecret): string {
  return getSecretName(secret).replace(/[^A-Za-z0-9._-]+/g, '_')
}
