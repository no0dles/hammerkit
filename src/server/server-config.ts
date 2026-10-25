import { isIP } from 'net'
import { z } from 'zod'
import { parse } from 'yaml'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { parseDuration, parseSize } from '../utils/units'
import { getVersion } from '../version'
import { getAllowListError, isAllowEntry, networkSchema } from '../schema/network-schema'
import {
  buildFileSecretAccountSchema,
  buildFileSecretProvidersSchema,
} from '../schema/build-file-secret-provider-schema'
import { SecretCatalog } from '../secrets/secret-catalog'
import { isRepoPattern } from './repo'
import { exceedsNetwork, formatNetwork, limitNetwork, parseWorkNetwork } from '../planner/work-network'

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
        // a ServiceAccount of the server's namespace: a token of it (an hour, made for
        // each Job, for `audience`) is put at /var/run/hammerkit/account/token, for a cloud that
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

// an IPv4 or IPv6 range, such as 10.0.0.0/8
const cidrSchema = z.string().refine((value) => {
  const [address, prefix, ...rest] = value.split('/')
  const family = isIP(address)
  return (
    rest.length === 0 && family !== 0 && /^\d{1,3}$/.test(prefix ?? '') && Number(prefix) <= (family === 4 ? 32 : 128)
  )
}, 'expected an address range, such as 10.0.0.0/8 or fd00::/8')

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

// Where a cluster keeps sandboxes: a claim per sandbox in its caller's namespace
const kubernetesSandboxesSchema = z
  .object({
    // the image of the short pods that fetch, read and change the files of a sandbox:
    // hammerkit with git and ripgrep, as the image of this version is
    image: z.string().min(1).default(`no0dles/hammerkit:${getVersion()}`),
    // what each of the two claims of a sandbox requests: one holds its files, which tasks
    // mount, the other its git data, which only the pod of its files mounts
    size: size.default('4Gi'),
    // of the claims of sandboxes; the class of tasks' claims, else the cluster's default,
    // when left out. With a class of their own, a ResourceQuota on that class in each
    // caller's namespace holds `sandboxes.limits`.
    storageClass: z.string().min(1).optional(),
    // how long the pod of a sandbox's files stays after the last request
    idle: duration.default('1m'),
    // of the pod of a sandbox's files, which runs git and ripgrep over all of them
    resources: z
      .object({ requests: quantitiesSchema.optional(), limits: quantitiesSchema.optional() })
      .strict()
      .default({ requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '2Gi' } }),
  })
  .strict()
  .default({})

export const DEFAULT_DENIED_EGRESS = [
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fe80::/10',
  'fc00::/7',
]

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
    // what the claim of a task or service requests when it states no `volumeSize`, and
    // the most one may state (see getMaxVolumeSize when left out)
    volumeSize: size.default('1Gi'),
    maxVolumeSize: size.optional(),
    // how long the claim of a task stays after the run that mounted it last, for the next
    // run of the same source to mount its outputs as they are; false removes it at the end
    // of the run
    keepVolumes: z.union([duration, z.literal(false)]).default('15m'),
    pools: z
      .array(kubernetesPoolSchema)
      .min(1)
      .default([{ name: 'default', platform: { os: 'linux', arch: 'amd64' }, nodeSelector: {}, tolerations: [] }]),
    // per secret provider, the image its command runs in: secrets are read in the
    // Job of the task, not by the server. `allow` are the hosts its command reaches, such
    // as secretmanager.googleapis.com: the egress proxy of a task with a limited network
    // lets the init containers that read its secrets reach them, and nothing else does
    providers: z
      .record(
        z
          .object({
            image: z.string().min(1),
            allow: z
              .array(
                z
                  .string()
                  .refine(
                    (host) => isAllowEntry(host) && !host.includes(':'),
                    'expected a host name such as secretmanager.googleapis.com or *.example.com'
                  )
              )
              .min(1)
              .optional(),
          })
          .strict()
      )
      .default({}),
    // the ResourceQuota of every caller's namespace, such as `requests.cpu: '8'`
    quota: z.record(z.union([z.string().min(1), z.number()]).transform(String)).optional(),
    // what a container without `resources` requests (a LimitRange), so it is
    // admitted under a quota that limits compute
    defaultResources: z
      .object({ requests: quantitiesSchema.optional(), limits: quantitiesSchema.optional() })
      .strict()
      .optional(),
    sandboxes: kubernetesSandboxesSchema,
    // the ClusterRole the server binds to itself in each caller's namespace, so it needs
    // no rights in the namespaces of others (see the docs on RBAC)
    runRole: kubernetesNameSchema.default('hammerkit-runs'),
    // where the pods of runs with an open network may not connect to: by default the
    // link-local ranges with the metadata endpoints of the clouds (and the node's identity)
    // and the private ones, where the cluster's nodes, pods and services and the networks
    // behind it are, so `open` means the internet
    deniedEgress: z.array(cidrSchema).default(DEFAULT_DENIED_EGRESS),
    // the addresses in deniedEgress they may reach anyway, such as an internal registry
    // or a database a TCP forward of `allow` goes to
    allowedEgress: z.array(cidrSchema).default([]),
    // the operator states that the cluster's network plugin enforces NetworkPolicy, as a
    // build file's environment does: hammerkit can't tell from the API, and without it a
    // task with a limited network fails rather than runs open
    networkPolicy: z.literal('enforced').optional(),
  })
  .strict()

export type KubernetesBackend = z.infer<typeof kubernetesBackendSchema>

// the most a task's claim may request on a server whose operator states no maxVolumeSize
export const DEFAULT_MAX_VOLUME_SIZE = '10Gi'

// The most a task's or service's claim may request: the operator's maxVolumeSize, else
// DEFAULT_MAX_VOLUME_SIZE or the backend's volumeSize when that is more. A build file
// states its volumeSize, so without a bound any caller could make the operator pay for a
// disk of any size.
export function getMaxVolumeSize(backend: Pick<KubernetesBackend, 'volumeSize' | 'maxVolumeSize'>): string {
  if (backend.maxVolumeSize) {
    return backend.maxVolumeSize
  }
  return parseSize(backend.volumeSize) > parseSize(DEFAULT_MAX_VOLUME_SIZE)
    ? backend.volumeSize
    : DEFAULT_MAX_VOLUME_SIZE
}

export const accountLevelSchema = z.enum(['use', 'request'])
export type AccountLevel = z.infer<typeof accountLevelSchema>

// What a caller may do with the build files: run what is published, propose new
// versions that someone else approves, or publish. Each level includes the lower.
export const buildsLevelSchema = z.enum(['run', 'propose', 'publish'])
export type BuildsLevel = z.infer<typeof buildsLevelSchema>

const repoPatternSchema = z.string().refine(isRepoPattern, 'expected host/path, such as github.com/corp/*')

// A branch of a sandbox grant, as written: `agent/**`, `agent/*` (one level) or a name.
const branchPatternSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      /^[A-Za-z0-9._*/-]+$/.test(value) &&
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('//') &&
      !value.includes('..'),
    'expected a branch or a pattern of branches, such as agent/**'
  )

// `pull`: a sandbox may start from (and fetch) a matching branch; `push` also pushes to it.
export const sandboxBranchTypeSchema = z.enum(['pull', 'push'])
export type SandboxBranchType = z.infer<typeof sandboxBranchTypeSchema>

// One repository (`host/path` pattern) an entitlement may keep sandboxes of, with a type
// per branch pattern. Its branches count for this repository only.
export const sandboxGrantSchema = z
  .object({
    repo: repoPatternSchema,
    branches: z
      .record(branchPatternSchema, sandboxBranchTypeSchema)
      .refine((branches) => Object.keys(branches).length > 0, 'name the branches a sandbox may start from'),
  })
  .strict()
export type SandboxGrant = z.infer<typeof sandboxGrantSchema>

export const entitlementSchema = z
  .object({
    ...whoShape,
    // `use`: runs on the account at once and approves the runs others request on it;
    // `request`: runs wait until somebody who may `use` the account approves them
    accounts: z.record(accountNameSchema, accountLevelSchema).default({}),
    // the repositories (`host/path` patterns) the caller may run from a git ref
    repos: z.array(repoPatternSchema).default([]),
    builds: buildsLevelSchema.optional(),
    // `read`: may look up which tasks runs passed for files of the `repos` (remote verify),
    // and nothing more; a builds level includes it
    checks: z.literal('read').optional(),
    // the repositories the caller may keep sandboxes of, checkouts on the server that runs
    // work on: a list of its own, the `repos` above are for runs from a ref
    sandboxes: z.array(sandboxGrantSchema).optional(),
  })
  .strict()
  .superRefine((entitlement, ctx) => {
    checkWho(entitlement, ctx)
    if (
      Object.keys(entitlement.accounts).length === 0 &&
      entitlement.builds === undefined &&
      entitlement.checks === undefined &&
      !entitlement.sandboxes?.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'name accounts to use or request, a builds level, checks or sandboxes',
      })
    }
    if (entitlement.checks && entitlement.repos.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repos'],
        message: 'checks are read for repositories: name them in repos',
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
        // the most any task or service of a run reaches besides its needs: none, open
        // or { allow: [hosts] }. A version that asks for more is refused at publish.
        network: networkSchema.default('open'),
        // the most a task or service that reads a secret, or a variable of the server
        // other than PATH, HOME and CI, reaches, under `network`: so a tool it runs can't
        // send the value anywhere. Checked like `network`.
        secretNetwork: networkSchema.default('open'),
        // which tasks take arguments: `any` but those that say `args: false`, or
        // `declared`, only those that say `args: true`
        args: z.enum(['any', 'declared']).default('any'),
        // how long a passed check stays for `remote verify` to find (see checks.ts)
        checksKeep: duration.default('30d'),
      })
      .strict()
      .default({}),
    // checkouts of callers on the server that runs work on (the `sandboxes` of an
    // entitlement). They stay until they are deleted, within these limits.
    sandboxes: z
      .object({
        // what the tasks of a run on a sandbox may run on, out of `runtimes`. A local task
        // would run as the user of the server and could read every other sandbox, so
        // `local` has to be named here too. Left out, `docker` when the server runs
        // containers, see getSandboxRuntimes
        runtimes: z
          .array(z.enum(['docker', 'local']))
          .min(1)
          .optional(),
        // the most open network a task or service of a run on a sandbox gets, written as
        // a task's `network`: only the services it needs by default
        network: networkSchema.default('none'),
        // the variables of `runs.env.allow` an `env:` secret of a run on a sandbox may
        // read: none by default, a sandbox holds code nobody reviewed
        env: z
          .object({ allow: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_()]*$/)).default([]) })
          .strict()
          .default({}),
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
    const sandboxNetwork = parseWorkNetwork(config.sandboxes.network)
    const runsNetwork = parseWorkNetwork(config.runs.network)
    if (exceedsNetwork(sandboxNetwork, runsNetwork)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sandboxes', 'network'],
        message: `runs on sandboxes get at most runs.network (${formatNetwork(runsNetwork)}), not ${formatNetwork(
          sandboxNetwork
        )}`,
      })
    }
    // what a sandbox run gets, the lower of the two: their TCP forwards together need a port each
    const sandboxCeiling = limitNetwork(sandboxNetwork, runsNetwork)
    const shared = sandboxCeiling.type === 'allow' ? getAllowListError(sandboxCeiling.hosts) : null
    if (shared) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sandboxes', 'network'],
        message: `under runs.network, ${shared}`,
      })
    }
    // on a cluster a local task runs in a pod of a pool's tool image, which can be limited
    if (
      config.sandboxes.runtimes?.includes('local') &&
      config.sandboxes.network !== 'open' &&
      config.backend.type === 'host'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sandboxes', 'network'],
        message: 'hammerkit can not limit the network of a local task, set network: open to allow local in sandboxes',
      })
    }
    config.sandboxes.env.allow.forEach((name, index) => {
      if (!config.runs.env.allow.includes(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sandboxes', 'env', 'allow', index],
          message: `${name} is not in runs.env.allow, no run can read it`,
        })
      }
    })
    config.sandboxes.runtimes?.forEach((runtime, index) => {
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
        // the commands run as the account's own identity, never the one of the node
        // or of the provider's image, which every account would share
        if (Object.keys(account.providers).length > 0 && !account.kubernetes) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['accounts', name, 'kubernetes'],
            message: `the account ${name} reads secrets in the Jobs of tasks, name the serviceAccount or secret it reads them as`,
          })
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
      if (backend.maxVolumeSize && parseSize(backend.volumeSize) > parseSize(backend.maxVolumeSize)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backend', 'volumeSize'],
          message: `a claim of ${backend.volumeSize} is more than maxVolumeSize of ${backend.maxVolumeSize}`,
        })
      }
      const sandboxes = backend.sandboxes
      if (sandboxes.storageClass && sandboxes.storageClass === backend.storageClass) {
        // the quota on the class would count the claims of tasks too
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backend', 'sandboxes', 'storageClass'],
          message: 'give sandboxes a storage class of their own, or leave it out to use the one of tasks',
        })
      }
      if (parseSize(sandboxes.size) > parseSize(config.sandboxes.limits.bytes)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backend', 'sandboxes', 'size'],
          message: `a sandbox of ${sandboxes.size} is more than sandboxes.limits.bytes of ${config.sandboxes.limits.bytes}`,
        })
      }
      if (config.runtimes.includes('local') && !backend.pools.some((pool) => pool.toolImage)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backend', 'pools'],
          message: 'local tasks run in the toolImage of a pool, give a pool one or remove local from runtimes',
        })
      }
      // a limited network is a NetworkPolicy there, which only some network plugins enforce
      if (config.runs.network !== 'open' && backend.networkPolicy !== 'enforced') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backend', 'networkPolicy'],
          message:
            'runs.network limits every task with a NetworkPolicy, set networkPolicy: enforced once the network plugin of the cluster enforces them',
        })
      }
      if (config.runs.secretNetwork !== 'open' && backend.networkPolicy !== 'enforced') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backend', 'networkPolicy'],
          message:
            'runs.secretNetwork limits the tasks that read secrets with a NetworkPolicy, set networkPolicy: enforced once the network plugin of the cluster enforces them',
        })
      }
      if (
        config.sandboxes.network !== 'open' &&
        backend.networkPolicy !== 'enforced' &&
        config.entitlements.some((entitlement) => entitlement.sandboxes?.length)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['backend', 'networkPolicy'],
          message:
            'sandboxes.network limits the tasks of sandboxes with a NetworkPolicy, set networkPolicy: enforced once the network plugin of the cluster enforces them, or sandboxes.network: open',
        })
      }
    }
    if (config.runs.network !== 'open' && config.runtimes.includes('local') && backend.type === 'host') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runs', 'network'],
        message: 'the network of a local task can not be limited, allow only the docker runtime with runs.network',
      })
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

// What the tasks of a run on a sandbox may run on: `sandboxes.runtimes`, else containers
// when the server runs them. Empty on a server with only `runtimes: [local]`, which then
// runs nothing on sandboxes.
export function getSandboxRuntimes(config: Pick<ServerConfig, 'runtimes' | 'sandboxes'>): ('docker' | 'local')[] {
  return config.sandboxes.runtimes ?? config.runtimes.filter((runtime) => runtime === 'docker')
}

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
