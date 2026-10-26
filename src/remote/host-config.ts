import { join } from 'path'
import { z } from 'zod'
import { parse, stringify } from 'yaml'
import { Environment } from '../executer/environment'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'

// Names with a meaning of their own in `run.on` / `--on`
export const RESERVED_SERVER_NAMES = ['local', 'auto']

const serverNamePattern = /^[a-z0-9][a-z0-9._-]*$/i

const checked = (what: string) => (value: string, ctx: z.RefinementCtx) => {
  try {
    normalizeServerUrl(value, what)
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message })
  }
}

// `clientId`, `audience` and `scope` are what a login asks the identity provider
// for. They are pinned the first time a login happens (or given to `remote add`),
// so a server can't change them later, see device-login.ts.
export const hostServerSchema = z
  .object({
    url: z.string().superRefine(checked('url')),
    issuer: z.string().superRefine(checked('issuer')),
    clientId: z.string().min(1).optional(),
    audience: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
  })
  .strict()

// A command that prints the token for a server instead of a login, see token-source.ts.
// It is bound to the url and issuer it was registered for, like a sign-in, and lives
// beside `servers` rather than in it: hammerkit before 1.27 refuses unknown keys of a
// server, but keeps unknown top-level keys. It is only ever read from the host config,
// a build file can't name one.
const tokenCommandSchema = z
  .object({ url: z.string(), issuer: z.string(), command: z.string().trim().min(1) })
  .passthrough()

// Unknown top-level keys are kept when the file is written back, so a newer
// hammerkit's settings survive an older one editing the file.
export const hostConfigSchema = z
  .object({
    servers: z.record(hostServerSchema).default({}),
    tokenCommands: z.record(tokenCommandSchema).optional(),
    run: z.object({ on: z.string().optional() }).passthrough().default({}),
  })
  .passthrough()

export type HostServer = z.infer<typeof hostServerSchema>
export type HostConfig = z.infer<typeof hostConfigSchema>

// A server as the clients use it: with its token command, if one is registered for it.
export type RegisteredServer = HostServer & { tokenCommand?: string }

// Names like "constructor" must not find inherited members.
export function hasServer(servers: Record<string, HostServer>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(servers, name)
}

// The token command of a server, unless it was registered for another url or issuer (an
// older hammerkit that pointed the name elsewhere leaves it behind).
export function getTokenCommand(config: HostConfig, name: string): string | undefined {
  const commands = config.tokenCommands ?? {}
  const entry = Object.prototype.hasOwnProperty.call(commands, name) ? commands[name] : undefined
  const server = hasServer(config.servers, name) ? config.servers[name] : undefined
  return entry && server && entry.url === server.url && entry.issuer === server.issuer ? entry.command : undefined
}

export function getRegisteredServer(config: HostConfig, name: string): RegisteredServer {
  const tokenCommand = getTokenCommand(config, name)
  return { ...config.servers[name], ...(tokenCommand ? { tokenCommand } : {}) }
}

function setTokenCommand(config: HostConfig, name: string, entry: z.infer<typeof tokenCommandSchema> | undefined) {
  const commands = { ...(config.tokenCommands ?? {}) }
  if (entry) {
    commands[name] = entry
  } else {
    delete commands[name]
  }
  if (Object.keys(commands).length > 0) {
    config.tokenCommands = commands
  } else {
    delete config.tokenCommands
  }
}

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
// An issuer is compared as a string with the `iss` of tokens, so it keeps the
// spelling it was given (some providers end it with a slash, some don't).
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
  return what === 'issuer' ? value : url.toString().replace(/\/+$/, '')
}

export interface AddServerOptions {
  issuer: string
  clientId?: string
  audience?: string
  scope?: string
  // a command that prints the token; left out keeps the one registered, false removes it
  tokenCommand?: string | false
  force?: boolean
}

const PINNED = ['clientId', 'audience', 'scope'] as const

export async function addServer(
  environment: Environment,
  name: string,
  url: string,
  options: AddServerOptions
): Promise<RegisteredServer> {
  validateServerName(name)
  const server: HostServer = {
    url: normalizeServerUrl(url),
    issuer: normalizeServerUrl(options.issuer, 'issuer'),
  }
  for (const key of PINNED) {
    if (options[key]) {
      server[key] = options[key]
    }
  }
  if (typeof options.tokenCommand === 'string' && !options.tokenCommand.trim()) {
    throw new Error('the token command must not be empty, use --no-token-command to remove it')
  }
  const config = await readHostConfig(environment)
  const existing = hasServer(config.servers, name) ? config.servers[name] : undefined
  const sameServer = (a: HostServer, b: HostServer) => a.url === b.url && a.issuer === b.issuer
  // Adding the same server again keeps what was pinned (by a login, too) unless it is given,
  // so a later `remote add ... --token-command` needs no --force.
  if (existing && sameServer(existing, server)) {
    for (const key of PINNED) {
      if (!server[key] && existing[key]) {
        server[key] = existing[key]
      }
    }
  }
  const changed = (a: HostServer, b: HostServer) => !sameServer(a, b) || PINNED.some((key) => a[key] !== b[key])
  if (existing && changed(existing, server) && !options.force) {
    throw new Error(
      `server "${name}" is already registered as ${existing.url} (issuer ${existing.issuer}); ` +
        `use --force to point it somewhere else`
    )
  }
  // The command decides which identity's token goes to the server: changing it does not
  // redirect anything, but a name pointed at another server does not keep the old one.
  const kept = existing && sameServer(existing, server) ? getTokenCommand(config, name) : undefined
  const tokenCommand =
    typeof options.tokenCommand === 'string'
      ? options.tokenCommand.trim()
      : options.tokenCommand === undefined
        ? kept
        : undefined
  config.servers[name] = server
  setTokenCommand(
    config,
    name,
    tokenCommand ? { url: server.url, issuer: server.issuer, command: tokenCommand } : undefined
  )
  await writeHostConfig(environment, config)
  return { ...server, ...(tokenCommand ? { tokenCommand } : {}) }
}

export async function removeServer(environment: Environment, name: string): Promise<{ resetDefault: boolean }> {
  const config = await readHostConfig(environment)
  if (!hasServer(config.servers, name)) {
    throw new Error(`server "${name}" is not registered`)
  }
  delete config.servers[name]
  setTokenCommand(config, name, undefined)
  const resetDefault = config.run.on === name
  if (resetDefault) {
    delete config.run.on
  }
  await writeHostConfig(environment, config)
  return { resetDefault }
}

export async function setDefaultLocation(environment: Environment, on: string): Promise<void> {
  const config = await readHostConfig(environment)
  if (!RESERVED_SERVER_NAMES.includes(on) && !hasServer(config.servers, on)) {
    throw new Error(`server "${on}" is not registered; add it with: hammerkit remote add ${on} <url> --issuer <url>`)
  }
  config.run.on = on
  await writeHostConfig(environment, config)
}

// Remember what the first login asked the identity provider for; later logins
// have to ask for the same.
export async function pinLogin(
  environment: Environment,
  name: string,
  pins: Pick<HostServer, 'clientId' | 'audience' | 'scope'>
): Promise<void> {
  const config = await readHostConfig(environment)
  if (!hasServer(config.servers, name)) {
    return
  }
  Object.assign(config.servers[name], pins)
  await writeHostConfig(environment, config)
}
