import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { isIPv4 } from 'net'
import { RbacV1Subject, V1LimitRange, V1NetworkPolicy, V1ResourceQuota, V1RoleBinding } from '@kubernetes/client-node'
import { KubernetesObjectHeader, replace, statusCodeOf } from '../kubernetes/apply'
import { getRunLabelValue, RUN_LABEL } from '../kubernetes/job-placement'
import { createKubernetesInstances, KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { getErrorMessage } from '../log'
import { NETWORK_LABEL, NETWORK_LIMITED, NETWORK_PROXY } from '../kubernetes/network-policy'
import { sleep } from '../utils/sleep'
import { WorkKubernetesEnvironment, WorkKubernetesWorkspace } from '../planner/work-environment'
import { SandboxClaim } from './sandbox-storage'
import { getVersion } from '../version'
import { cacheNamespace, HostExecutor, HostExecutorOptions, RunPlacement } from './executor'
import { expireKeptClaims, sweepKeptClaims } from '../kubernetes/kept-claims'
import { parseDuration } from '../utils/units'
import { Run, RunContext, RunExecutor } from './runs'
import { getMaxVolumeSize, KubernetesBackend, ServerConfig } from './server-config'

// the name of the quota and limit range the server keeps in a caller's namespace
const POLICY_NAME = 'hammerkit'
const MANAGED_LABEL = 'hammerkit.dev/managed'
// how long the end of a run waits for its pods and claims to be gone
const RELEASE_TIMEOUT = 120_000
// where a pod of the cluster finds the token and certificate of its ServiceAccount
const IN_CLUSTER_NAMESPACE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'

/**
 * The namespace of a caller: the prefix and a hash of their issuer and subject. A
 * subject is the caller's own, so nobody else's runs, claims or quota are in it.
 */
export function getCallerNamespace(prefix: string, owner: { iss: string; sub: string }): string {
  return `${prefix}${createHash('sha256').update(`${owner.iss}\0${owner.sub}`).digest('hex').slice(0, 16)}`
}

/**
 * The namespace of a service run: one of its own, as the services stay up for hours while
 * the caller's other runs go on in theirs (one at a time, each removing what the one
 * before left).
 */
export function getServiceRunNamespace(prefix: string, run: string, wakes = 0): string {
  // a woken run starts in a namespace of its own, the one it slept in may still be removed
  const name = wakes > 0 ? `up\0${run}\0${wakes}` : `up\0${run}`
  return `${prefix}${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
}

// the label of the namespace of a service run: the run label value of its run
export const SERVICE_RUN_LABEL = 'hammerkit.dev/service-run'

// Whether a namespace is one getCallerNamespace makes with this prefix: a server named `hk`
// passes over the namespaces of a server named `hk-test` on the same cluster.
export function isCallerNamespace(prefix: string, name: string): boolean {
  return name.startsWith(prefix) && /^[0-9a-f]{16}$/.test(name.slice(prefix.length))
}

// How the server and the processes of its runs reach the cluster: a kubeconfig and
// context the operator names, else the server's default kubeconfig, else the cluster
// the server runs in (its pod's ServiceAccount, found through the variables
// Kubernetes sets in every pod, which a run's process gets too).
export function getClusterAccess(
  backend: KubernetesBackend,
  processEnvs: { [key: string]: string | undefined }
): { kubeConfig?: string; context?: string; env: { [key: string]: string } } {
  if (backend.kubeconfig) {
    return { kubeConfig: backend.kubeconfig, context: backend.context, env: {} }
  }
  const fallback = processEnvs.KUBECONFIG?.split(process.platform === 'win32' ? ';' : ':')[0]
  const kubeConfig = fallback || join(processEnvs.HOME ?? homedir(), '.kube', 'config')
  if (existsSync(kubeConfig)) {
    return { kubeConfig, context: backend.context, env: {} }
  }
  const env: { [key: string]: string } = {}
  for (const name of ['KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT']) {
    const value = processEnvs[name]
    if (value) {
      env[name] = value
    }
  }
  return { context: backend.context, env }
}

function readInClusterNamespace(): string | undefined {
  try {
    return readFileSync(IN_CLUSTER_NAMESPACE, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * The NetworkPolicies of a caller's namespace. A namespace is no network boundary on its
 * own: without them a task could connect to the pods of other callers, to the server
 * and to the metadata endpoint of the cloud, which hands out the node's identity.
 * - ingress of a pod with an open network: connections from the pods of its namespace
 *   only (the services a task needs)
 * - egress of a pod with an open network, and of an egress proxy: its namespace, DNS,
 *   and any address but the denied ranges (link-local and private by default), plus the
 *   allowed ones
 * Policies add up, so neither selects the pods of a limited item: its own policy (see
 * buildNetworkPolicy) is all it may reach, DNS left out, and all that may reach it. An
 * egress proxy takes connections from its item only (buildProxyPolicy).
 */
export function getNamespacePolicies(
  namespace: string,
  deniedEgress: string[],
  allowedEgress: string[] = []
): (V1NetworkPolicy & KubernetesObjectHeader)[] {
  const metadata = (name: string) => ({
    name,
    namespace,
    annotations: { 'hammerkit.dev/version': getVersion() },
    labels: { [MANAGED_LABEL]: 'true' },
  })
  const block = (cidr: string, except: string[]) => ({ ipBlock: { cidr, ...(except.length ? { except } : {}) } })
  return [
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata('hammerkit-ingress'),
      spec: {
        podSelector: { matchExpressions: [{ key: NETWORK_LABEL, operator: 'DoesNotExist' }] },
        policyTypes: ['Ingress'],
        ingress: [{ _from: [{ podSelector: {} }] }],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata('hammerkit-egress'),
      spec: {
        podSelector: { matchExpressions: [{ key: NETWORK_LABEL, operator: 'NotIn', values: [NETWORK_LIMITED] }] },
        policyTypes: ['Egress'],
        egress: [
          { to: [{ podSelector: {} }] },
          // to whatever resolver the pod is given, a node-local cache included
          {
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
          {
            to: [
              block(
                '0.0.0.0/0',
                deniedEgress.filter((range) => isIPv4(range.split('/')[0]))
              ),
              block(
                '::/0',
                deniedEgress.filter((range) => !isIPv4(range.split('/')[0]))
              ),
            ],
          },
          // the operator's exceptions, which rules add up to
          ...(allowedEgress.length > 0 ? [{ to: allowedEgress.map((cidr) => ({ ipBlock: { cidr } })) }] : []),
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata('hammerkit-proxy-ingress'),
      spec: {
        // an egress proxy takes only what its own policy lets in: one whose policy went
        // before the pod ended takes nothing
        podSelector: { matchLabels: { [NETWORK_LABEL]: NETWORK_PROXY } },
        policyTypes: ['Ingress'],
        ingress: [],
      },
    },
  ]
}

/**
 * What lets the server into the namespace of a service run, to the ports of its endpoints:
 * policies add up, so this one opens the pods to the server's namespace besides what the
 * others let in, limited ones too.
 */
// The server reaches the ports of the endpoints, from its own namespace, and no other port:
// what else the run starts (a database) stays for the pods of the run.
export function getServerIngressPolicy(
  namespace: string,
  server: string,
  ports: number[]
): V1NetworkPolicy & KubernetesObjectHeader {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: 'hammerkit-server-ingress',
      namespace,
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: { [MANAGED_LABEL]: 'true' },
    },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress'],
      ingress:
        ports.length > 0
          ? [
              {
                _from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': server } } }],
                ports: [...new Set(ports)].map((port) => ({ protocol: 'TCP', port })),
              },
            ]
          : [],
    },
  }
}

// The namespace of a service run goes with all it holds; waits up to `timeout` for it.
export async function removeServiceRunNamespace(
  instance: KubernetesInstance,
  namespace: string,
  timeout: number
): Promise<void> {
  try {
    await instance.coreApi.deleteNamespace({ name: namespace, propagationPolicy: 'Background' })
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return
    }
    throw e
  }
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      await instance.coreApi.readNamespace({ name: namespace })
    } catch (e) {
      if (statusCodeOf(e) === 404) {
        return
      }
      throw e
    }
    await sleep(1000)
  }
}

/**
 * The server's rights in a caller's namespace: the operator's ClusterRole, bound there
 * only, so the server needs no rights on Secrets or pods anywhere else.
 */
export function getRunRoleBinding(
  namespace: string,
  role: string,
  subject: RbacV1Subject
): V1RoleBinding & KubernetesObjectHeader {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: 'hammerkit-runs',
      namespace,
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: { [MANAGED_LABEL]: 'true' },
    },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role },
    subjects: [subject],
  }
}

/**
 * Runs the tasks of runs as Jobs on a cluster. A run is planned and driven by a
 * process of the server as on a host (see HostExecutor); what changes is where its
 * container tasks and services go: into the caller's namespace, on the nodes of the
 * operator's pools, with the secrets of providers read in the Job itself. The runs
 * of a caller execute side by side in their namespace, up to `runs.limits.running`:
 * the objects of a run are named and found by its run label (getItemKey), so two runs
 * of the same task have their own. What two runs share are the claims the server keeps
 * (`backend.keepVolumes`) of a scope (getVolumeScope): the runs of one scope go one at
 * a time (exclusive). When a run ends, everything made for it is removed, but for the
 * kept claims, which go once they expired.
 */
export class KubernetesExecutor implements RunExecutor {
  private readonly host: HostExecutor
  private readonly instance: KubernetesInstance
  private readonly access: ReturnType<typeof getClusterAccess>
  private readonly namespace: string
  private readonly namespaces: CallerNamespaces
  // per caller namespace, what changes objects of the whole namespace: its setup, the
  // removal of what a stopped server left, the sweeps of kept claims. The last one waiting.
  private readonly queues = new Map<string, Promise<void>>()
  // per caller namespace, the runs that execute in it: by run label, their volume scope
  private readonly active = new Map<string, Map<string, string>>()
  // how long the claims of tasks stay after a run, 0 for not at all
  private readonly keep: number
  // per caller namespace, when its kept claims are next looked at
  private readonly sweeps = new Map<string, { at: number; timer: NodeJS.Timeout }>()
  // whether the kept claims a server left when it stopped were looked for
  private swept = false
  // the namespaces of the service runs that execute, and whether those of earlier ones went
  private readonly serviceRuns = new Set<string>()
  private serviceRunsSwept = false
  private readonly log?: (line: string) => void

  constructor(
    private readonly config: ServerConfig & { backend: KubernetesBackend },
    processEnvs: { [key: string]: string | undefined },
    options: Omit<HostExecutorOptions, 'placement'>
  ) {
    this.access = getClusterAccess(config.backend, processEnvs)
    this.instance = createKubernetesInstances({
      type: 'kubernetes',
      namespace: 'default',
      kubeConfig: this.access.kubeConfig,
      context: this.access.context,
      httpRoutes: [],
      networkPolicyEnforced: config.backend.networkPolicy === 'enforced',
    })
    const namespace = config.backend.namespace ?? readInClusterNamespace()
    if (!namespace) {
      throw new Error(
        'backend.namespace: name the namespace of the server, where the credentials of the accounts are; ' +
          'it is only found on its own in a pod of the cluster'
      )
    }
    this.namespace = namespace
    this.namespaces = new CallerNamespaces(this.instance, config.backend)
    this.keep = config.backend.keepVolumes === false ? 0 : parseDuration(config.backend.keepVolumes)
    this.log = options.log
    this.host = new HostExecutor({ ...options, placement: this.placement() })
  }

  async execute(run: Run, context: RunContext): Promise<void> {
    if (run.up) {
      if (run.source.type === 'sandbox') {
        throw new Error('on a cluster a service run starts from a branch, push the sandbox and start it from there')
      }
      // in a namespace of its own, apart from the caller's runs and their claims
      return this.host.execute(run, context)
    }
    const namespace = getCallerNamespace(this.config.backend.namespacePrefix, run.owner)
    const label = getRunLabelValue(run.id)
    let runs = this.active.get(namespace)
    if (!runs) {
      runs = new Map()
      this.active.set(namespace, runs)
    }
    runs.set(label, getVolumeScope(run))
    try {
      await this.host.execute(run, context)
    } finally {
      runs.delete(label)
      if (runs.size === 0 && this.active.get(namespace) === runs) {
        this.active.delete(namespace)
      }
    }
  }

  private namespaceOf(run: Run): string {
    const prefix = this.config.backend.namespacePrefix
    return run.up ? getServiceRunNamespace(prefix, run.id, run.wakes) : getCallerNamespace(prefix, run.owner)
  }

  // The runs of a scope share its kept claims, which one of them may change at a time:
  // what a task finds in one is what the last run left there. Without kept claims, runs
  // share no object and nothing is held.
  exclusive(run: Run): string | undefined {
    if (this.keep === 0 || run.up) {
      return undefined
    }
    return `${getCallerNamespace(this.config.backend.namespacePrefix, run.owner)}/${getVolumeScope(run)}`
  }

  // The scopes of the runs that execute in the namespace, but `except`'s: their kept claims
  // are theirs to mount and stay. A server that keeps none mounts none.
  private scopesInUse(namespace: string, except?: string): Set<string> {
    if (this.keep === 0) {
      return new Set()
    }
    return new Set(
      [...(this.active.get(namespace) ?? new Map<string, string>()).entries()]
        .filter(([label]) => label !== except)
        .map(([, scope]) => scope)
    )
  }

  // What changes objects of a whole namespace happens one at a time, not what its runs do
  private enqueue(namespace: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(namespace) ?? Promise.resolve()
    const execution = previous.then(fn)
    const settled = execution.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(namespace, settled)
    settled.then(() => {
      if (this.queues.get(namespace) === settled) {
        this.queues.delete(namespace)
      }
    })
    return execution
  }

  private placement(): RunPlacement {
    return {
      prepare: async (run: Run, context: RunContext, work?: { root: string; claim?: SandboxClaim }) => {
        const namespace = this.namespaceOf(run)
        if (run.up) {
          if (context.signal.aborted) {
            throw new Error('the run was cancelled')
          }
          this.serviceRuns.add(namespace)
          this.sweepServiceRuns()
          // reached by the server at the Services of its endpoints
          await this.namespaces.prepare(namespace, {
            serviceRun: getRunLabelValue(run.id),
            server: this.namespace,
            ports: (run.up.endpoints ?? []).map((endpoint) => endpoint.port),
            quota: this.config.runs.up.quota,
          })
          context.emit({ type: 'log', task: 'hammerkit', stream: 'stdout', text: `runs in the namespace ${namespace}` })
          return { kubernetes: this.environmentOf(run, namespace), env: this.access.env }
        }
        const label = getRunLabelValue(run.id)
        await this.enqueue(namespace, async () => {
          if (context.signal.aborted) {
            throw new Error('the run was cancelled')
          }
          await this.namespaces.prepare(namespace)
          // what an earlier run left when the server stopped before its end: the objects of
          // a run that does not execute. One that starts after this waits for it here
          // before it makes any.
          const running = [...new Set([label, ...(this.active.get(namespace)?.keys() ?? [])])]
          await removeRunObjects(
            this.instance,
            namespace,
            `${RUN_LABEL},${RUN_LABEL} notin (${running.join(',')})`,
            RELEASE_TIMEOUT
          )
          // the claims earlier runs kept that expired; the others this run may mount
          const { next } = await sweepKeptClaims(this.instance, namespace, {
            now: new Date(),
            keep: this.keep > 0,
            timeout: RELEASE_TIMEOUT,
            inUse: this.scopesInUse(namespace, label),
          })
          if (next) {
            this.sweepLater(namespace, Math.max(0, next.getTime() - Date.now()))
          }
        })
        this.sweepLeftClaims()
        context.emit({ type: 'log', task: 'hammerkit', stream: 'stdout', text: `runs in the namespace ${namespace}` })
        return { kubernetes: this.environmentOf(run, namespace, work), env: this.access.env }
      },
      release: async (run: Run, context: RunContext) => {
        const namespace = this.namespaceOf(run)
        if (run.up) {
          try {
            await removeServiceRunNamespace(this.instance, namespace, RELEASE_TIMEOUT)
          } catch (e) {
            // at least nothing of it runs on: its objects are the server's to remove (runRole)
            const forbidden = statusCodeOf(e) === 403
            const text = forbidden
              ? `the server may not delete the namespace ${namespace}, its ClusterRole needs delete on namespaces (see the backend docs); removing what runs in it`
              : `the namespace ${namespace} could not be removed: ${getErrorMessage(e)}`
            this.log?.(text)
            context.emit({ type: 'log', task: 'hammerkit', stream: 'stderr', text })
            try {
              await removeRunObjects(this.instance, namespace, RUN_LABEL, RELEASE_TIMEOUT)
            } catch (inner) {
              context.emit({
                type: 'log',
                task: 'hammerkit',
                stream: 'stderr',
                text: `what the run made in ${namespace} could not be removed: ${getErrorMessage(inner)}`,
              })
            }
            // the next look removes the namespace
            this.serviceRunsSwept = false
          } finally {
            this.serviceRuns.delete(namespace)
          }
          return
        }
        try {
          const selector = `${RUN_LABEL}=${getRunLabelValue(run.id)}`
          await removeRunObjects(this.instance, namespace, selector, RELEASE_TIMEOUT)
        } catch (e) {
          context.emit({
            type: 'log',
            task: 'hammerkit',
            stream: 'stderr',
            text: `what the run made in ${namespace} could not be removed: ${getErrorMessage(e)}`,
          })
        }
        if (this.keep > 0) {
          try {
            await expireKeptClaims(this.instance, namespace, getRunLabelValue(run.id), new Date(Date.now() + this.keep))
          } catch (e) {
            // without an expiry, the next look at the namespace removes them
            context.emit({
              type: 'log',
              task: 'hammerkit',
              stream: 'stderr',
              text: `the claims the run kept in ${namespace} could not be given their expiry: ${getErrorMessage(e)}`,
            })
          }
          this.sweepLater(namespace, this.keep)
        }
      },
    }
  }

  // The cluster as the process of a run sees it: the namespace its tasks and services go in.
  private environmentOf(
    run: Run,
    namespace: string,
    work?: { root: string; claim?: SandboxClaim }
  ): WorkKubernetesEnvironment {
    const backend = this.config.backend
    return {
      type: 'kubernetes',
      namespace,
      kubeConfig: this.access.kubeConfig,
      context: this.access.context,
      httpRoutes: [],
      storageClass: backend.storageClass,
      volumeSize: backend.volumeSize,
      maxVolumeSize: getMaxVolumeSize(backend),
      networkPolicyEnforced: backend.networkPolicy === 'enforced',
      server: {
        run: run.id,
        namespace: this.namespace,
        pools: backend.pools,
        providers: backend.providers,
        accounts: Object.fromEntries(
          Object.entries(this.config.accounts).flatMap(([name, account]) =>
            account.kubernetes ? [[name, account.kubernetes]] : []
          )
        ),
        ...(work?.claim ? { workspace: getWorkspace(work.root, work.claim, namespace) } : {}),
        // the claims of a service run go with its namespace
        ...(this.keep > 0 && !run.up ? { volumeScope: getVolumeScope(run) } : {}),
      },
    }
  }

  // Once, on the first service run: the namespaces of service runs the server left when it
  // stopped, whose services went with it
  // Once when the server starts, and on the next service run after a namespace could not be
  // removed: the namespaces of service runs that none of the server's runs is in, whose
  // services went with the process of a server that stopped
  sweepServiceRuns(): void {
    if (this.serviceRunsSwept) {
      return
    }
    this.serviceRunsSwept = true
    Promise.resolve()
      .then(() => this.instance.coreApi.listNamespace({ labelSelector: `${MANAGED_LABEL}=true,${SERVICE_RUN_LABEL}` }))
      .then(async (namespaces) => {
        for (const namespace of namespaces.items) {
          const name = namespace.metadata?.name
          if (
            name &&
            isCallerNamespace(this.config.backend.namespacePrefix, name) &&
            !this.serviceRuns.has(name) &&
            !namespace.metadata?.deletionTimestamp
          ) {
            this.log?.(`removing the namespace ${name} of a service run from before the server started`)
            await removeServiceRunNamespace(this.instance, name, 0)
          }
        }
      })
      .catch((e) => this.log?.(`the namespaces of service runs could not be removed: ${getErrorMessage(e)}`))
  }

  // The kept claims of a namespace that expired go at the soonest expiry the server knows
  // of, but those of a scope a run of the caller executes in
  private sweepLater(namespace: string, delay: number): void {
    const at = Date.now() + delay + 1000
    const pending = this.sweeps.get(namespace)
    if (pending && pending.at <= at) {
      return
    }
    clearTimeout(pending?.timer)
    const timer = setTimeout(() => {
      this.sweeps.delete(namespace)
      this.enqueue(namespace, () => this.sweep(namespace)).catch(
        (e) => this.log?.(`the kept claims in ${namespace} could not be removed: ${getErrorMessage(e)}`)
      )
    }, at - Date.now())
    timer.unref()
    this.sweeps.set(namespace, { at, timer })
  }

  private async sweep(namespace: string): Promise<void> {
    const { removed, next } = await sweepKeptClaims(this.instance, namespace, {
      now: new Date(),
      keep: this.keep > 0,
      timeout: RELEASE_TIMEOUT,
      inUse: this.scopesInUse(namespace),
    })
    if (removed.length > 0) {
      this.log?.(`removed ${removed.length} kept claims in ${namespace}`)
    }
    if (next) {
      this.sweepLater(namespace, Math.max(0, next.getTime() - Date.now()))
    }
  }

  // Once, on the first run: the claims the server kept before it stopped, in the namespaces
  // of other callers too, whose next run may be far off
  private sweepLeftClaims(): void {
    if (this.swept) {
      return
    }
    this.swept = true
    Promise.resolve()
      .then(() => this.instance.coreApi.listNamespace({ labelSelector: `${MANAGED_LABEL}=true,!${SERVICE_RUN_LABEL}` }))
      .then((namespaces) => {
        for (const namespace of namespaces.items) {
          const name = namespace.metadata?.name
          if (
            name &&
            isCallerNamespace(this.config.backend.namespacePrefix, name) &&
            !namespace.metadata?.deletionTimestamp
          ) {
            this.sweepLater(name, 0)
          }
        }
      })
      .catch((e) => this.log?.(`the namespaces of callers could not be listed: ${getErrorMessage(e)}`))
  }
}

// What may mount a claim a run kept: the runs of the same repository, as they share the
// cache, and on a sandbox the runs of that sandbox only, whose claim is on the same node or
// zone as the kept ones. The owner is the namespace's.
export function getVolumeScope(run: Run): string {
  if (run.source.type === 'sandbox') {
    return `sandbox-${createHash('sha256').update(run.source.id).digest('hex').slice(0, 24)}`
  }
  return cacheNamespace(run)
}

/**
 * The namespaces of callers on the cluster: named by the caller (getCallerNamespace),
 * made on first use, with the operator's quota.
 */
export class CallerNamespaces {
  // who the server is to the cluster, the subject of its RoleBinding in a caller's namespace
  private subject: Promise<RbacV1Subject> | undefined

  constructor(
    private readonly instance: KubernetesInstance,
    private readonly backend: KubernetesBackend
  ) {}

  name(owner: { iss: string; sub: string }): string {
    return getCallerNamespace(this.backend.namespacePrefix, owner)
  }

  // The caller's namespace: made by the server and kept apart from the others. The
  // server binds its rights there, isolates the network of the pods, applies the
  // operator's quota and gives containers without resources default requests, so they
  // are admitted under a quota on compute. All of it is replaced on every run, so the
  // namespace follows the config.
  async prepare(
    namespace: string,
    // a service run's own namespace: its label, the namespace of the server that reaches its
    // endpoints, and its quota
    serviceRun?: { serviceRun: string; server: string; ports: number[]; quota?: Record<string, string> }
  ): Promise<void> {
    const backend = this.backend
    let existing
    try {
      existing = await this.instance.coreApi.readNamespace({ name: namespace })
    } catch (e) {
      if (statusCodeOf(e) !== 404) {
        throw e
      }
    }
    if (existing && existing.metadata?.labels?.[MANAGED_LABEL] !== 'true') {
      throw new Error(`the namespace ${namespace} was not made by hammerkit, the server does not run tasks in it`)
    }
    if (!existing) {
      try {
        await this.instance.coreApi.createNamespace({
          body: {
            metadata: {
              name: namespace,
              labels: {
                [MANAGED_LABEL]: 'true',
                'hammerkit.dev/caller': namespace,
                ...(serviceRun ? { [SERVICE_RUN_LABEL]: serviceRun.serviceRun } : {}),
                // no privileged pods, host paths or host network, whatever a build asks
                'pod-security.kubernetes.io/enforce': 'baseline',
              },
            },
          },
        })
      } catch (createError) {
        if (statusCodeOf(createError) !== 409) {
          throw createError
        }
      }
    }
    await replace(this.instance, getRunRoleBinding(namespace, backend.runRole, await this.whoAmI()))
    const [first, ...policies] = getNamespacePolicies(namespace, backend.deniedEgress, backend.allowedEgress)
    // the API server may refuse what the binding allows for a moment after it was made
    await untilAllowed(() => replace(this.instance, first))
    for (const policy of [
      ...policies,
      ...(serviceRun ? [getServerIngressPolicy(namespace, serviceRun.server, serviceRun.ports)] : []),
    ]) {
      await replace(this.instance, policy)
    }
    const metadata = {
      name: POLICY_NAME,
      namespace,
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: { [MANAGED_LABEL]: 'true' },
    }
    const quota: V1ResourceQuota & KubernetesObjectHeader = {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata,
      spec: { hard: serviceRun?.quota ?? backend.quota },
    }
    const defaults = backend.defaultResources
    const limits: V1LimitRange & KubernetesObjectHeader = {
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata,
      spec: {
        limits: [
          {
            type: 'Container',
            ...(defaults?.requests ? { defaultRequest: defaults.requests } : {}),
            ...(defaults?.limits ? { _default: defaults.limits } : {}),
          },
        ],
      },
    }
    for (const [object, wanted] of [
      [quota, !!(serviceRun?.quota ?? backend.quota)],
      [limits, !!defaults],
    ] as const) {
      if (wanted) {
        await replace(this.instance, object)
      } else {
        // one the config had before
        await this.instance.objectApi.delete(object).catch((e) => {
          if (statusCodeOf(e) !== 404) {
            throw e
          }
        })
      }
    }
  }

  private whoAmI(): Promise<RbacV1Subject> {
    if (!this.subject) {
      this.subject = this.instance.authApi
        .createSelfSubjectReview({ body: { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' } })
        .then((review) => {
          const name = review.status?.userInfo?.username
          if (!name) {
            throw new Error('the cluster did not say who the server is (SelfSubjectReview)')
          }
          return { kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name }
        })
      this.subject.catch(() => {
        this.subject = undefined
      })
    }
    return this.subject
  }
}

// The claim of a sandbox as the Jobs of its run mount it: the run's copy of the files is
// `root`, a source below it is the same path below `subPath` in the claim.
function getWorkspace(root: string, claim: SandboxClaim, namespace: string): WorkKubernetesWorkspace {
  if (claim.namespace !== namespace) {
    throw new Error(`the sandbox is in ${claim.namespace}, the run in ${namespace}`)
  }
  return {
    root,
    claim: claim.name,
    subPath: claim.subPath,
    label: claim.label,
    ...(claim.pod ? { pod: claim.pod } : {}),
  }
}

// Everything a run made in the caller's namespace, by the label selector of the run:
// Jobs with their pods, Deployments (services and egress proxies), Services, claims,
// Secrets and the NetworkPolicies of limited networks, which go last so no pod of the
// run outlives its policy.
// Deletes what a run made. The NetworkPolicies go last, once the pods are: a limited
// pod's own policy is all that limits it.
export async function removeRunObjects(
  instance: KubernetesInstance,
  namespace: string,
  labelSelector: string,
  timeout: number
): Promise<void> {
  const selector = { namespace, labelSelector }
  await instance.batchApi.deleteCollectionNamespacedJob({ ...selector, propagationPolicy: 'Background' })
  await instance.appsApi.deleteCollectionNamespacedDeployment({ ...selector, propagationPolicy: 'Background' })
  await instance.coreApi.deleteCollectionNamespacedPod({ ...selector, gracePeriodSeconds: 0 })
  await instance.coreApi.deleteCollectionNamespacedService(selector)
  await instance.coreApi.deleteCollectionNamespacedSecret(selector)
  await instance.coreApi.deleteCollectionNamespacedPersistentVolumeClaim(selector)
  // the next run of the caller also uses the same claim names
  await awaitRunObjectsGone(instance, namespace, labelSelector, timeout)
  const policies = await instance.objectApi.list(
    'networking.k8s.io/v1',
    'NetworkPolicy',
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    labelSelector
  )
  for (const policy of policies.items) {
    // the items of a list do not say their kind
    const metadata = { name: policy.metadata?.name, namespace }
    await instance.objectApi
      .delete({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata })
      .catch((e) => {
        if (statusCodeOf(e) !== 404) {
          throw e
        }
      })
  }
}

async function untilAllowed<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (statusCodeOf(e) !== 403 || attempt >= attempts) {
        throw e
      }
      await sleep(500)
    }
  }
}

// Until the pods and claims of a run are gone: a claim is kept while a pod uses it.
export async function awaitRunObjectsGone(
  instance: KubernetesInstance,
  namespace: string,
  labelSelector: string,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    const pods = await instance.coreApi.listNamespacedPod({ namespace, labelSelector })
    const claims = await instance.coreApi.listNamespacedPersistentVolumeClaim({ namespace, labelSelector })
    const left = [...pods.items, ...claims.items].map((item) => `${item.kind ?? ''} ${item.metadata?.name}`.trim())
    if (left.length === 0) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`still there after ${Math.round(timeout / 1000)}s: ${left.join(', ')}`)
    }
    await sleep(1000)
  }
}
