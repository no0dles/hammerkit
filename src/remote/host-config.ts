import { join } from 'path'
import { z } from 'zod'
import { parse, stringify } from 'yaml'
import { Environment } from '../executer/environment'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'

// Names with a meaning of their own in `run.on` / `--on`
export const RESERVED_SERVER_NAMES = ['local', 'auto']

const serverNamePattern = /^[a-z0-9][a-z0-9._-]*$/i

export const hostServerSchema = z
  .object({
    url: z.string(),
    issuer: z.string(),
  })
  .strict()

// Unknown top-level keys are kept when the file is written back, so a newer
// hammerkit's settings survive an older one editing the file.
export const hostConfigSchema = z
  .object({
    servers: z.record(hostServerSchema).default({}),
    run: z.object({ on: z.string().optional() }).passthrough().default({}),
  })
  .passthrough()

export type HostServer = z.infer<typeof hostServerSchema>
export type HostConfig = z.infer<typeof hostConfigSchema>

export function getHostConfigPath(environment: Environment): string {
  return environment.processEnvs.HAMMERKIT_CONFIG ?? join(getHammerkitDirectory(), 'config.yaml')
}

export async function readHostConfig(environment: Environment): Promise<HostConfig> {
  const path = getHostConfigPath(environment)
  if (!(await environment.file.exists(path))) {
    return hostConfigSchema.parse({})
  }
  let raw: unknown
  try {
    raw = parse(await environment.file.read(path))
  } catch (e) {
    throw new Error(`unable to read ${path}: ${(e as Error).message}`)
  }
  const result = hostConfigSchema.safeParse(raw ?? {})
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`invalid ${path}: ${issue.path.join('.') || 'config'}: ${issue.message}`)
  }
  return result.data
}

export async function writeHostConfig(environment: Environment, config: HostConfig): Promise<void> {
  const path = getHostConfigPath(environment)
  await environment.file.createDirectory(join(path, '..'))
  await environment.file.writeFile(path, stringify(config))
}

export function validateServerName(name: string): string {
  if (RESERVED_SERVER_NAMES.includes(name.toLowerCase())) {
    throw new Error(`"${name}" is reserved and cannot be used as a server name`)
  }
  if (!serverNamePattern.test(name)) {
    throw new Error(
      `invalid server name "${name}": use letters, digits, ".", "_" and "-", starting with a letter or digit`
    )
  }
  return name
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

// A server receives the source of a run and the caller's OAuth token, so it must
// be reached over https; plain http is only for a server on this machine. The
// result has no trailing slash, so one server has one spelling.
export function normalizeServerUrl(value: string, what = 'url'): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`invalid ${what} "${value}"`)
  }
  if (url.username || url.password) {
    throw new Error(`the ${what} must not contain credentials`)
  }
  if (url.search || url.hash) {
    throw new Error(`the ${what} must not contain a query or fragment`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(`the ${what} must use https (http is only allowed for localhost), got "${value}"`)
  }
  return url.toString().replace(/\/+$/, '')
}

export interface AddServerOptions {
  issuer: string
  force?: boolean
}

export async function addServer(
  environment: Environment,
  name: string,
  url: string,
  options: AddServerOptions
): Promise<HostServer> {
  validateServerName(name)
  const server: HostServer = {
    url: normalizeServerUrl(url),
    issuer: normalizeServerUrl(options.issuer, 'issuer'),
  }
  const config = await readHostConfig(environment)
  const existing = config.servers[name]
  if (existing && (existing.url !== server.url || existing.issuer !== server.issuer) && !options.force) {
    throw new Error(
      `server "${name}" is already registered as ${existing.url} (issuer ${existing.issuer}); ` +
        `use --force to point it somewhere else`
    )
  }
  config.servers[name] = server
  await writeHostConfig(environment, config)
  return server
}

export async function removeServer(environment: Environment, name: string): Promise<{ resetDefault: boolean }> {
  const config = await readHostConfig(environment)
  if (!(name in config.servers)) {
    throw new Error(`server "${name}" is not registered`)
  }
  delete config.servers[name]
  const resetDefault = config.run.on === name
  if (resetDefault) {
    delete config.run.on
  }
  await writeHostConfig(environment, config)
  return { resetDefault }
}

export async function setDefaultLocation(environment: Environment, on: string): Promise<void> {
  const config = await readHostConfig(environment)
  if (!RESERVED_SERVER_NAMES.includes(on) && !(on in config.servers)) {
    throw new Error(`server "${on}" is not registered; add it with: hammerkit remote add ${on} <url> --issuer <url>`)
  }
  config.run.on = on
  await writeHostConfig(environment, config)
}
