import { z } from 'zod'
import { parse } from 'yaml'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { parseDuration } from '../utils/units'

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

export const serverPlatformSchema = z
  .object({
    os: z.enum(['linux', 'macos', 'windows']),
    arch: z.enum(['amd64', 'arm64']),
  })
  .strict()

// The issuer is compared with the `iss` of a token as written, and its keys are
// fetched from it, so it has to be https (http only for local testing).
const issuerUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname.replace(/^\[|\]$/g, '')))
    )
  } catch {
    return false
  }
}, 'issuer must be an https url (http only for localhost)')

export const issuerSchema = z
  .object({
    issuer: issuerUrlSchema,
    audience: z.string().min(1),
    // the claim listing the groups of the caller
    groupsClaim: z.string().min(1).default('groups'),
    // the public OAuth client `remote login` signs in with (device authorization
    // grant); without one this issuer can only be used with a token obtained
    // elsewhere, such as a CI job's or an agent's own
    clientId: z.string().min(1).optional(),
    // what the login asks for, such as `openid api://hammerkit/.default`
    scope: z.string().min(1).default('openid'),
  })
  .strict()

// What a published build file is called: the project, as a build file author names it.
export const definitionName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, 'use letters, digits, ".", "_" and "-", starting with a letter or digit')

const subjectSchema = z.object({ iss: z.string().min(1), sub: z.string().min(1) }).strict()
const groupSchema = z.object({ iss: z.string().min(1), name: z.string().min(1) }).strict()
const claimsSchema = z.object({ iss: z.string().min(1), match: z.record(z.string()) }).strict()

// Who: the person or client (`subject`), everyone in a group of an issuer
// (`group`), or any token of an issuer whose claims match (`claims`, for CI jobs:
// repository, ref, environment). Only validated token claims are matched.
const whoShape = {
  subject: subjectSchema.optional(),
  group: groupSchema.optional(),
  claims: claimsSchema.optional(),
}

function checkWho(who: Who, ctx: z.RefinementCtx) {
  const named = [who.subject, who.group, who.claims].filter((w) => w !== undefined)
  if (named.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'name exactly one of subject, group or claims' })
  }
  if (who.claims && Object.keys(who.claims.match).length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claims', 'match'], message: 'match at least one claim' })
  }
}

export interface Who {
  subject?: z.infer<typeof subjectSchema>
  group?: z.infer<typeof groupSchema>
  claims?: z.infer<typeof claimsSchema>
}

export const entitlementSchema = z
  .object({
    ...whoShape,
    // admin: runs on these accounts at once, and approves the runs others
    // request on them
    accounts: z.array(z.string().min(1)).default([]),
    // may request runs on these accounts, which wait until an admin of the account
    // (someone with it in `accounts`) approves them
    request: z.array(z.string().min(1)).optional(),
    // the build files (by name) the caller may publish, `*` for any; a separate
    // permission from running them, so who defines work and who runs it can differ
    publish: z.array(z.union([z.literal('*'), definitionName])).optional(),
    // the account used when the caller names none; one of accounts or request
    default: z.string().min(1).optional(),
    // where the code may come from: the caller's working tree or a git ref
    source: z
      .array(z.enum(['upload', 'ref']))
      .min(1)
      .optional(),
  })
  .strict()
  .superRefine((entitlement, ctx) => {
    checkWho(entitlement, ctx)
    if (
      entitlement.accounts.length === 0 &&
      (entitlement.request ?? []).length === 0 &&
      (entitlement.publish ?? []).length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'name accounts to use or request, or build files to publish',
      })
    }
    if (
      entitlement.default &&
      ![...entitlement.accounts, ...(entitlement.request ?? [])].includes(entitlement.default)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: 'default has to be one of accounts or request',
      })
    }
  })

const duration = z.string().refine((value) => {
  try {
    return parseDuration(value) > 0
  } catch {
    return false
  }
}, 'expected a duration like 30m, 1h or 1d')

export type Issuer = z.infer<typeof issuerSchema>
export type Entitlement = z.infer<typeof entitlementSchema>

// The server config is written by an operator and reviewed like code, so a typo
// is an error and not a silently ignored key.
export const serverConfigSchema = z
  .object({
    listen: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(0).max(65535).default(8480),
      })
      .strict()
      .default({}),
    // paths of a certificate and key
    tls: z
      .object({ cert: z.string().min(1), key: z.string().min(1) })
      .strict()
      .optional(),
    // plain http carries OAuth tokens, so it is only accepted on the loopback
    // interface, or when a proxy in front terminates TLS and this says so
    behindTlsProxy: z.boolean().default(false),
    // the OAuth issuers whose tokens the server accepts, and the audience those
    // tokens have to carry
    issuers: z.array(issuerSchema).min(1, 'at least one issuer is needed, OAuth is the only way to call the server'),
    // who may use which service account; default deny, so no entry means no account
    entitlements: z.array(entitlementSchema).default([]),
    approvals: z
      .object({
        // how long a run waits for its approval before it is rejected
        timeout: duration.default('1h'),
        // runs waiting at the same time, more are refused
        maxWaiting: z.number().int().min(1).default(100),
      })
      .strict()
      .default({}),
    // where the server keeps what must survive a restart: the published build files
    storage: z
      .object({ directory: z.string().min(1).optional() })
      .strict()
      .default({}),
    // limits of the run registry
    runs: z
      .object({
        // runs that execute at the same time, the others wait in queue
        maxConcurrent: z.number().int().min(1).default(4),
        // finished runs that are kept for their state and logs
        keep: z.number().int().min(1).default(200),
      })
      .strict()
      .default({}),
    backend: z
      .object({
        type: z.literal('host'),
        // what this machine offers; detected when left out
        platform: serverPlatformSchema.optional(),
      })
      .strict()
      .default({ type: 'host' }),
  })
  .strict()
  .superRefine((config, ctx) => {
    const issuers = config.issuers.map((i) => i.issuer)
    config.entitlements.forEach((entitlement, index) => {
      const iss = (entitlement.subject ?? entitlement.group ?? entitlement.claims)?.iss
      if (iss && !issuers.includes(iss)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entitlements', index],
          message: `issuer ${iss} is not one of the accepted issuers`,
        })
      }
    })
    if (!config.tls && !config.behindTlsProxy && !LOOPBACK_HOSTS.includes(config.listen.host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['listen', 'host'],
        message: `plain http on ${config.listen.host} would send tokens in the clear, set tls or behindTlsProxy: true`,
      })
    }
  })

export type ServerConfig = z.infer<typeof serverConfigSchema>
export type ServerPlatform = z.infer<typeof serverPlatformSchema>

export async function readServerConfig(environment: Environment, path: string): Promise<ServerConfig> {
  if (!(await environment.file.exists(path))) {
    throw new Error(`unable to read ${path}: no such file`)
  }
  let raw: unknown
  try {
    raw = parse(await environment.file.read(path))
  } catch (e) {
    throw new Error(`unable to read ${path}: ${getErrorMessage(e)}`)
  }
  const result = serverConfigSchema.safeParse(raw ?? {})
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    throw new Error(`invalid ${path}: ${where}${issue.message}`)
  }
  return result.data
}

export function detectPlatform(): ServerPlatform {
  const os = { darwin: 'macos', win32: 'windows' }[process.platform as string] ?? 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return { os, arch } as ServerPlatform
}
