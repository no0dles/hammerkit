import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { Environment } from '../../../executer/environment'

export interface RegistryCredentials {
  username: string
  password: string
}

interface DockerConfig {
  auths?: { [host: string]: { auth?: string; username?: string; password?: string; identitytoken?: string } }
  credHelpers?: { [host: string]: string }
  credsStore?: string
}

async function readDockerConfig(environment: Environment): Promise<DockerConfig | null> {
  const dir = environment.processEnvs.DOCKER_CONFIG ?? join(homedir(), '.docker')
  const path = join(dir, 'config.json')
  if (!(await environment.file.exists(path))) {
    return null
  }
  try {
    return JSON.parse(await environment.file.read(path))
  } catch {
    return null
  }
}

// `docker-credential-<helper> get` reads the server on stdin and prints
// {"Username": ..., "Secret": ...}; a missing entry exits non-zero.
function runCredentialHelper(helper: string, host: string): Promise<RegistryCredentials | null> {
  return new Promise((resolve) => {
    let stdout = ''
    let child
    try {
      child = spawn(`docker-credential-${helper}`, ['get'], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    child.on('error', () => resolve(null))
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        resolve(parsed.Secret ? { username: parsed.Username ?? '', password: parsed.Secret } : null)
      } catch {
        resolve(null)
      }
    })
    child.stdin.end(host)
  })
}

// Resolve credentials for a registry host from the docker config that
// `docker login` (and CI login actions such as docker/login-action) write, so
// the cache introduces no credential surface of its own. Order matches docker: credHelpers, then inline auths, then the
// global credsStore.
export async function resolveRegistryCredentials(
  credentialHost: string,
  environment: Environment
): Promise<RegistryCredentials | null> {
  const config = await readDockerConfig(environment)
  if (!config) {
    return null
  }

  const helper = config.credHelpers?.[credentialHost]
  if (helper) {
    return runCredentialHelper(helper, credentialHost)
  }

  const inline = config.auths?.[credentialHost] ?? config.auths?.[`https://${credentialHost}`]
  if (inline?.auth) {
    const decoded = Buffer.from(inline.auth, 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator > 0) {
      return { username: decoded.substring(0, separator), password: decoded.substring(separator + 1) }
    }
  }
  if (inline?.username && inline.password) {
    return { username: inline.username, password: inline.password }
  }

  if (config.credsStore) {
    return runCredentialHelper(config.credsStore, credentialHost)
  }
  return null
}
