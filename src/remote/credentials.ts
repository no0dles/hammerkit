import { randomBytes } from 'crypto'
import { mkdir, open, rename, stat, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { Environment } from '../executer/environment'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { HostServer } from './host-config'

// A sign-in is bound to the server it was made for: if the name is registered
// again for another URL or issuer, the token is not sent there.
export interface StoredToken {
  url: string
  issuer: string
  accessToken: string
  // ms since epoch
  expiresAt: number
}

export function getCredentialsPath(environment: Environment): string {
  return environment.processEnvs.HAMMERKIT_CREDENTIALS ?? join(getHammerkitDirectory(), 'credentials.json')
}

async function readAll(environment: Environment): Promise<Record<string, StoredToken>> {
  const path = getCredentialsPath(environment)
  if (!(await environment.file.exists(path))) {
    return {}
  }
  try {
    const parsed = JSON.parse(await environment.file.read(path))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // a damaged file only costs a new sign-in
    return {}
  }
}

// Only the owner may read it, and it is replaced atomically. The temporary file
// has a name nobody can guess and is created exclusively (never through a link
// someone left behind), already private.
async function writeAll(environment: Environment, all: Record<string, StoredToken>): Promise<void> {
  const path = getCredentialsPath(environment)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(all, null, 2))
  } finally {
    await file.close()
  }
  try {
    await rename(temporary, path)
  } catch (e) {
    await unlink(temporary).catch(() => undefined)
    throw e
  }
}

// A token that others can read is as good as published: it isn't used.
async function assertPrivate(environment: Environment): Promise<void> {
  const path = getCredentialsPath(environment)
  if (process.platform === 'win32' || !(await environment.file.exists(path))) {
    return
  }
  const info = await stat(path)
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`${path} must belong to you and be private, fix it with: chmod 600 ${path}, or sign in again`)
  }
}

export async function saveToken(environment: Environment, name: string, token: StoredToken): Promise<void> {
  const all = await readAll(environment)
  all[name] = token
  await writeAll(environment, all)
}

export async function removeToken(environment: Environment, name: string): Promise<boolean> {
  const all = await readAll(environment)
  if (!all[name]) {
    return false
  }
  delete all[name]
  await writeAll(environment, all)
  return true
}

// The access token for a registered server, or the reason there is none.
export async function getAccessToken(
  environment: Environment,
  name: string,
  server: HostServer,
  now = Date.now()
): Promise<string> {
  await assertPrivate(environment)
  const all = await readAll(environment)
  const stored = Object.prototype.hasOwnProperty.call(all, name) ? all[name] : undefined
  const signIn = `sign in with: hammerkit remote login ${name}`
  if (!stored) {
    throw new Error(`not signed in to ${name}, ${signIn}`)
  }
  if (stored.url !== server.url || stored.issuer !== server.issuer) {
    throw new Error(`the sign-in to ${name} was made for another server, ${signIn}`)
  }
  if (stored.expiresAt <= now) {
    throw new Error(`the sign-in to ${name} has expired, ${signIn}`)
  }
  return stored.accessToken
}
