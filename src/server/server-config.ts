import { z } from 'zod'
import { parse } from 'yaml'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { parseDuration, parseSize } from '../utils/units'
import { networkSchema } from '../schema/network-schema'
import {
  buildFileSecretAccountSchema,
  buildFileSecretProvidersSchema,
} from '../schema/build-file-secret-provider-schema'
import { SecretCatalog } from '../secrets/secret-catalog'
import { isRepoPattern } from './repo'

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

// The service accounts a server knows. A run never names one: the accounts it
// uses are the ones its secrets are read as, and an entitlement says who may use
// or only request each.
const accountNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'a name starts with a letter and holds letters, digits, - and _')

const kubernetesNameSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'a Kubernetes name: lower case letters, digits and -')

export const accountSchema = z
  .object({
    description: z.string().min(1).max(200).optional(),
    // per secret provider, the environment that makes its command act as this
    // account; the credentials are files and variables of the operator's machine
    providers: buildFileSecretAccountSchema.shape.providers.default({}),
    // where the code of a run using this account may come from: `upload` and `ref` when
    // left out; a sandbox, which holds unreviewed changes, only when it is listed
    source: z
      .array(z.enum(['upload', 'ref', 'sandbox']))
      .min(1)
      .optional(),
    // the refs (branches or tags, `release/*` for a level) a run using this account
    // may be started from; a commit is not accepted then, it names no branch
    refs: z.array(z.string().min(1).max(200)).min(1).optional(),
    // On a Kubernetes backend: the credential the commands of the account's secrets
    // get in the Job of a task, under /var/run/hammerkit/account. The server holds
    // none of the secret manager's credentials.
    kubernetes: z
      .object({
        // a ServiceAccount of the server's namespace: a token of it (10 minutes, for
        // `audience`) is put at /var/run/hammerkit/account/token, for a cloud that
        // trusts the cluster's issuer (workload identity federation)
        serviceAccount: kubernetesNameSchema.optional(),
        audience: z.string().min(1).optional(),
        // a Secret of the server's namespace, each key a file of the directory, such
        // as a key file or the federation config that reads the token
        secret: kubernetesNameSchema.optional(),
      })
      .strict()
      .refine((value) => value.serviceAccount || value.secret, 'name a serviceAccount, a secret or both')
      .refine((value) => !value.audience || value.serviceAccount, 'audience is the one of the serviceAccount token')
      .optional(),
  })
  .strict()
  .superRefine((account, ctx) => {
    if (account.refs && (account.source?.length !== 1 || account.source[0] !== 'ref')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refs'],
        message: 'refs only restricts runs from a git ref, set source: [ref] too, an upload names no ref',
      })
    }
  })

export type Account = z.infer<typeof accountSchema>

// The tasks of runs execute on this machine, with its docker daemon and local tools.
const hostBackendSchema = z
  .object({
    type: z.literal('host'),
    // what this machine offers; detected when left out
    platform: serverPlatformSchema.optional(),
  })
  .strict()

const tolerationSchema = z
  .object({
    key: z.string().min(1).optional(),
    operator: z.enum(['Exists', 'Equal']).optional(),
    value: z.string().optional(),
    effect: z.enum(['NoSchedule', 'PreferNoSchedule', 'NoExecute']).optional(),
    tolerationSeconds: z.number().int().min(0).optional(),
  })
  .strict()

const quantitiesSchema = z.object({ cpu: z.string().min(1).optional(), memory: z.string().min(1).optional() }).strict()

// Nodes the tasks of runs are placed on. Container tasks go to the first pool; a
// local task runs in the `toolImage` of the pool that offers the platform it declares.
export const kubernetesPoolSchema = z
  .object({
    name: kubernetesNameSchema,
    // Linux only: macOS is not a node platform, Windows nodes are not supported yet
    platform: z
      .object({ os: z.literal('linux'), arch: z.enum(['amd64', 'arm64']) })
      .strict()
      .default({ os: 'linux', arch: 'amd64' }),
    // labels the nodes of the pool carry, besides kubernetes.io/os and kubernetes.io/arch
    nodeSelector: z.record(z.string()).default({}),
    tolerations: z.array(tolerationSchema).default([]),
    // the image local tasks run in on this pool
    toolImage: z.string().min(1).optional(),
  })
  .strict()

export type KubernetesPool = z.infer<typeof kubernetesPoolSchema>

// The tasks of runs execute as Jobs on a cluster, in a namespace per caller.
const kubernetesBackendSchema = z
  .object({
    type: z.literal('kubernetes'),
    // the cluster: a context of a kubeconfig, or the cluster the server runs in when
    // both are left out
    kubeconfig: z.string().min(1).optional(),
    context: z.string().min(1).optional(),
    // the server's own namespace, where the Secrets and ServiceAccounts of the accounts
    // are; the namespace of the server's pod when left out
    namespace: kubernetesNameSchema.optional(),
    // a caller's namespace is this and a hash of their identity, so two servers on
    // one cluster keep their callers apart with a prefix each
    namespacePrefix: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'lower case letters, digits and -, at most 31')
      .default('hammerkit-'),
    // of the claims tasks get; the cluster's default when left out
    storageClass: z.string().min(1).optional(),
    pools: z
      .array(kubernetesPoolSchema)
      .min(1)
      .default([{ name: 'default', platform: { os: 'linux', arch: 'amd64' }, nodeSelector: {}, tolerations: [] }]),
    // per secret provider, the image its command runs in: secrets are read in the
    // Job of the task, not by the server
    providers: z.record(z.object({ image: z.string().min(1) }).strict()).default({}),
    // the ResourceQuota of every caller's namespace, such as `requests.cpu: '8'`
    quota: z.record(z.union([z.string().min(1), z.number()]).transform(String)).optional(),
    // what a container without `resources` requests (a LimitRange), so it is
    // admitted under a quota that limits compute
    defaultResources: z
      .object({ requests: quantitiesSchema.optional(), limits: quantitiesSchema.optional() })
      .strict()
      .optional(),
  })
  .strict()

export type KubernetesBackend = z.infer<typeof kubernetesBackendSchema>

export const accountLevelSchema = z.enum(['use', 'request'])
export type AccountLevel = z.infer<typeof accountLevelSchema>

// What a caller may do with the build files: run what is published, propose new
// versions that someone else approves, or publish. Each level includes the lower.
export const buildsLevelSchema = z.enum(['run', 'propose', 'publish'])
export type BuildsLevel = z.infer<typeof buildsLevelSchema>

const repoPatternSchema = z.string().refine(isRepoPattern, 'expected host/path, such as github.com/corp/*')

export const entitlementSchema = z
  .object({
    ...whoShape,
    // `use`: runs on the account at once and approves the runs others request on it;
    // `request`: runs wait until somebody who may `use` the account approves them
    accounts: z.record(accountNameSchema, accountLevelSchema).default({}),
    // the repositories (`host/path` patterns) the caller may run from a git ref
    repos: z.array(repoPatternSchema).default([]),
    builds: buildsLevelSchema.optional(),
    // may keep sandboxes of the repositories in `repos`: checkouts on the server that
    // runs work on
    sandboxes: z.boolean().optional(),
  })
  .strict()
  .superRefine((entitlement, ctx) => {
    checkWho(entitlement, ctx)
    if (Object.keys(entitlement.accounts).length === 0 && entitlement.builds === undefined && !entitlement.sandboxes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'name accounts to use or request, a builds level or sandboxes',
      })
    }
    if (entitlement.sandboxes && entitlement.repos.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sandboxes'],
        message: 'a sandbox is a checkout of a repository, list the repositories in repos',
      })
    }
  })

// A repository the server can read: `github.com/corp/*` for an organisation,
// `gitlab.corp.com/platform/**` for a group with its subgroups. The credential is a
// secret of a provider, read as `account`, and handed to git for that fetch only.
export const sourceSchema = z
  .object({
    match: repoPatternSchema,
    secret: z
      .object({
        from: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*:.+$/, 'expected provider:reference'),
        account: accountNameSchema,
        // the user name of the basic authentication the token is sent with
        username: z.string().min(1).default('x-access-token'),
      })
      .strict()
      .optional(),
  })
  .strict()

export type Source = z.infer<typeof sourceSchema>

const duration = z.string().refine((value) => {
  try {
    return parseDuration(value) > 0
  } catch {
    return false
  }
}, 'expected a duration like 30m, 1h or 1d')

const size = z.string().refine((value) => {
  try {
    return parseSize(value) > 0
  } catch {
    return false
  }
}, 'expected a size like 500Mi, 20Gi or 1Ti')

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
    // the service accounts, and the commands that read secrets as them; a build file
    // can not declare either, only name an account on its secrets
    accounts: z.record(accountNameSchema, accountSchema).default({}),
    secretProviders: buildFileSecretProvidersSchema.default({}),
    // who may use which service account and which build files; default deny
    entitlements: z.array(entitlementSchema).default([]),
    approvals: z
      .object({
        // how long a run waits for its approval before it is rejected
        timeout: duration.default('1h'),
        // runs waiting at the same time, more are refused
        maxWaiting: z.number().int().min(1).default(100),
        // after a version was rejected, who proposed it can not propose that build
        // file again, and nobody that version, for this long
        cooldown: duration.default('10m'),
      })
      .strict()
      .default({}),
    // the repositories a run may get its code from, as patterns of `host/path`, and
    // the secret that reads them: a token in a secret provider, read as a service
    // account of the operator. The caller names a repository and a ref in the request,
    // never a url.
    sources: z.array(sourceSchema).default([]),
    // what tasks may run on: containers, and the local runtime that runs commands on
    // this machine as the user of the server. Local tasks read the whole file system of that
    // user, so they have to be allowed by name.
    runtimes: z
      .array(z.enum(['docker', 'local']))
      .min(1)
      .default(['docker']),
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
        // what one caller (issuer and subject) may have at a time, so a single
        // caller can not take the whole machine; over it a request gets 429
        limits: z
          .object({
            // runs that wait for an approval
            waiting: z.number().int().min(1).default(10),
            // runs that wait in the queue for a free place
            queued: z.number().int().min(1).default(20),
            // runs that execute at the same time, the others wait in the queue
            running: z.number().int().min(1).default(2),
          })
          .strict()
          .default({}),
        // a run that executes longer is stopped and fails
        maxDuration: duration.default('1h'),
        // log output kept per run; the rest is cut off
        maxLogBytes: z
          .number()
          .int()
          .min(1024)
          .default(1024 * 1024),
        // the environment of a run: the variables of the server process that tasks
        // (and the git fetch) can see. Nothing else of the server's environment
        // is passed on, so there is no list built in; an operator names what the
        // tools of the host need, such as PATH and DOCKER_HOST.
        env: z
          .object({
            allow: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_()]*$/)).default([]),
            // fixed values that are set in addition
            set: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    // checkouts of callers on the server that runs work on (`sandboxes: true` on an
    // entitlement). They stay until they are deleted, within these limits.
    sandboxes: z
      .object({
        // what the tasks of a run on a sandbox may run on, out of `runtimes`. A local task
        // would run as the user of the server and could read every other sandbox, so
        // `local` has to be named here too.
        runtimes: z
          .array(z.enum(['docker', 'local']))
          .min(1)
          .default(['docker']),
        // the most open network a task or service of a run on a sandbox gets, written as
        // a task's `network`: only the services it needs by default
        network: networkSchema.default('none'),
        // what one caller may keep; a sandbox over it can't be created
        limits: z
          .object({
            count: z.number().int().min(1).default(5),
            bytes: size.default('20Gi'),
          })
          .strict()
          .default({}),
        // what all sandboxes together may take
        total: size.default('500Gi'),
      })
      .strict()
      .default({}),
    backend: z.discriminatedUnion('type', [hostBackendSchema, kubernetesBackendSchema]).default({ type: 'host' }),
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
    for (const [name, account] of Object.entries(config.accounts)) {
      for (const provider of Object.keys(account.providers)) {
        if (!config.secretProviders[provider]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['accounts', name, 'providers', provider],
            message: `secret provider ${provider} is not declared in secretProviders`,
          })
        }
      }
    }
    config.entitlements.forEach((entitlement, index) => {
      for (const account of Object.keys(entitlement.accounts)) {
        if (!config.accounts[account]) {
          const known = Object.keys(config.accounts)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['entitlements', index, 'accounts', account],
            message: `unknown account ${account}, ${
              known.length > 0 ? `accounts: ${known.join(', ')}` : 'none is defined'
            }`,
          })
        }
      }
    })
    config.sources.forEach((source, index) => {
      if (!source.secret) {
        return
      }
      const { from, account } = source.secret
      const kind = from.substring(0, from.indexOf(':'))
      const where = ['sources', index, 'secret'] as (string | number)[]
      if (!config.accounts[account]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...where, 'account'],
          message: `unknown account ${account}`,
        })
      } else if (!config.accounts[account].providers[kind]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...where, 'from'],
          message: `account ${account} has no credentials for the provider ${kind}`,
        })
      }
      if (!config.secretProviders[kind]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...where, 'from'],
          message: `secret provider ${kind} is not declared in secretProviders`,
        })
      }
    })
    const readers = getSourceAccounts(config)
    config.entitlements.forEach((entitlement, index) => {
      for (const account of Object.keys(entitlement.accounts)) {
        if (readers.includes(account)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['entitlements', index, 'accounts', account],
            message: `the account ${account} reads the sources, no entitlement may name it`,
          })
        }
      }
    })
    if (config.sandboxes.runtimes.includes('local') && config.sandboxes.network !== 'open') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sandboxes', 'network'],
        message: 'hammerkit can not limit the network of a local task, set network: open to allow local in sandboxes',
      })
    }
    config.sandboxes.runtimes.forEach((runtime, index) => {
      if (!config.runtimes.includes(runtime)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sandboxes', 'runtimes', index],
          message: `the runtime ${runtime} is not in runtimes, the server does not run on it at all`,
        })
      }
    })
    const backend = config.backend
    for (const [name, account] of Object.entries(config.accounts)) {
      if (account.kubernetes && backend.type !== 'kubernetes') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accounts', name, 'kubernetes'],
          message: 'kubernetes credentials are for backend.type: kubernetes',
        })
      }
    }
    if (backend.type === 'kubernetes') {
      const pools = new Set<string>()
      backend.pools.forEach((pool, index) => {
        if (pools.has(pool.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['backend', 'pools', index, 'name'],
            message: `the pool ${pool.name} is named twice`,
          })
        }
        pools.add(pool.name)
      })
      // the secrets of tasks are read in their Job, with the image of the provider; the
      // ones of the sources are read by the server, which checks the code out itself
      const readers = getSourceAccounts(config)
      for (const [name, account] of Object.entries(config.accounts)) {
        if (readers.includes(name)) {
          continue
        }
        for (const provider of Object.keys(account.providers)) {
          if (!backend.providers[provider]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['backend', 'providers', provider],
              message: `the account ${name} reads ${provider} in the Jobs of tasks, name the image to run it in`,
            })
          }
        }
      }
      if (config.runtimes.includes('local') && !backend.pools.some((pool) => pool.toolImage)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backend', 'pools'],
          message: 'local tasks run in the toolImage of a pool, give a pool one or remove local from runtimes',
        })
      }
    }
    if (!config.tls && !config.behindTlsProxy && !LOOPBACK_HOSTS.includes(config.listen.host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['listen', 'host'],
        message: `plain http on ${config.listen.host} would send tokens in the clear, set tls or behindTlsProxy: true`,
      })
    }
  })

export type ServerConfig = z.infer<typeof serverConfigSchema>

// The accounts that read repositories: no caller uses them and no build file names them.
export function getSourceAccounts(config: Pick<ServerConfig, 'sources'>): string[] {
  return [...new Set(config.sources.flatMap((source) => (source.secret ? [source.secret.account] : [])))]
}
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

// The secret providers and accounts of the config as the engine reads them, so a
// secret of a build file is read as an account of the operator.
export function getSecretCatalog(config: ServerConfig): SecretCatalog {
  const providers: SecretCatalog['providers'] = {}
  for (const [name, provider] of Object.entries(config.secretProviders)) {
    providers[name] = {
      name,
      type: 'command',
      command: provider.command,
      env: provider.env ?? {},
      timeoutMs: parseDuration(provider.timeout ?? '30s'),
      declaredIn: 'the server config',
    }
  }
  const accounts: SecretCatalog['accounts'] = {}
  for (const [name, account] of Object.entries(config.accounts)) {
    accounts[name] = { name, default: false, providers: account.providers, declaredIn: 'the server config' }
  }
  return { providers, accounts, explicitAccounts: true }
}

export function detectPlatform(): ServerPlatform {
  const os = { darwin: 'macos', win32: 'windows' }[process.platform as string] ?? 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return { os, arch } as ServerPlatform
}
