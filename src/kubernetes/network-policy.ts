import {
  V1Container,
  V1Deployment,
  V1EnvVar,
  V1HostAlias,
  V1LabelSelector,
  V1NetworkPolicy,
  V1NetworkPolicyIngressRule,
  V1OwnerReference,
  V1Service,
} from '@kubernetes/client-node'
import { createHash } from 'crypto'
import { PassThrough, Writable } from 'stream'
import { createInterface } from 'readline'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { isContainerWorkServiceItem, WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService, isContainerWorkService } from '../planner/work-service'
import { getEffectiveNetwork, getTcpForwards, WorkNetwork } from '../planner/work-network'
import { KubernetesInstance } from './kubernetes-instance'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { getServiceIp } from './get-service-ip'
import { getVersion } from '../version'
import { awaitDeployRunningState } from './await-running-state'
import {
  EGRESS_PROXY_HOST,
  EGRESS_PROXY_IMAGE,
  formatEgressProxyEvent,
  getEgressProxyCommand,
  getEgressProxyPorts,
  getItemProxyEnvironment,
  getProxyClientEnvironment,
  parseEgressProxyEvent,
} from '../network/egress-proxy'
import { getErrorMessage } from '../log'
import { sleep } from '../utils/sleep'
import { getNetworkGateContainer, HELPER_SECURITY_CONTEXT } from './network-gate'
import { getPodPlacement, getRunLabels, RUN_LABEL } from './job-placement'

type ContainerItem = WorkItem<ContainerWorkTask | ContainerWorkService>

const ID_LABEL = 'hammerkit.dev/id'
// the run a task's pods belong to (on a server, the run of the server)
export { RUN_LABEL }
const PROXY_LABEL = 'hammerkit.dev/proxy-for'
const NETWORK_OF_LABEL = 'hammerkit.dev/network-of'
// on the proxy of a task on a sandbox: the sandbox, whose pod of files it stays with
const PROXY_OF_SANDBOX_LABEL = 'hammerkit.dev/proxy-of-sandbox'
const PROXY_READY_TIMEOUT_MS = 60000
// how long the pods of an item may take to end before their policy goes
const POD_END_TIMEOUT_MS = 120000
const POD_END_POLL_MS = 500
// on the pods of a limited item on a server: its own policy governs their egress, the
// one of the caller's namespace (see getNamespacePolicies) leaves them out
// (`limited`), and on its egress proxy (`proxy`), whose ingress its own policy decides
export const NETWORK_LABEL = 'hammerkit.dev/network'
export const NETWORK_LIMITED = 'limited'

export function getNetworkLabels(env: WorkKubernetesEnvironment, item: ContainerItem): { [label: string]: string } {
  return env.server && getEffectiveNetwork(item.data).type !== 'open' ? { [NETWORK_LABEL]: NETWORK_LIMITED } : {}
}

export interface KubernetesItemNetwork {
  // the proxy variables under `allow`
  env: V1EnvVar[]
  // the needed services, and the proxy under `allow`, by name
  hostAliases: V1HostAlias[]
  // run before the item's own containers: under a limited network, the gate
  // that waits until the policy holds
  initContainers: V1Container[]
  // stops following the proxy's log
  close(): void
}

// Whose pods a policy and proxy are for. A task's are per run (`run`), so
// concurrent runs never replace or remove each other's limits; a service has
// one Deployment, so one of each.
// A task of a run on a sandbox (`sandbox`) has its policy per run, and a proxy that
// stays for the next runs on the sandbox while the pod of the sandbox's files runs:
// the runs on a sandbox go one at a time, and each would otherwise wait for a proxy
// to start.
export interface KubernetesNetworkScope {
  run: string | null
  sandbox?: KubernetesSandboxScope
}

export interface KubernetesSandboxScope {
  // the label of the sandbox (WorkKubernetesWorkspace)
  label: string
  // the pod of its files that the run holds; without it, the proxy goes with the run
  pod?: { name: string; uid: string }
}

// The proxy of an item: by what its pods select it, its name, and, on a sandbox, the
// files pod it goes with.
interface ProxyIdentity {
  key: string
  name: string
  sandbox?: KubernetesSandboxScope
  owner?: V1OwnerReference
}

// A key short enough for a Service name (63 characters) with its prefix. A server's run
// label is longer than a run id of the CLI, and its first 8 digits tell runs apart.
function getNetworkKey(item: ContainerItem, scope: KubernetesNetworkScope): string {
  return scope.run ? `${item.id().substring(0, 32)}-${scope.run.substring(0, 8)}` : item.id()
}

export function getProxyName(item: ContainerItem, scope: KubernetesNetworkScope): string {
  return `hammerkit-proxy-${getNetworkKey(item, scope)}`
}

function getRunProxy(item: ContainerItem, scope: KubernetesNetworkScope): ProxyIdentity {
  return { key: getNetworkKey(item, scope), name: getProxyName(item, scope) }
}

// A proxy that outlives its run is told apart by all it is made of: a run whose task,
// network, needed services, server or pod of files changed gets one of its own, and the
// one before goes (removeSandboxProxies).
export function getSandboxProxy(
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  network: Extract<WorkNetwork, { type: 'allow' }>,
  hostAliases: V1HostAlias[],
  sandbox: KubernetesSandboxScope
): ProxyIdentity {
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        sandbox: sandbox.label,
        pod: sandbox.pod?.uid ?? null,
        item: item.id(),
        network,
        env: getItemProxyEnvironment(item),
        hostAliases,
        placement: env.server ? getPodPlacement(env.server, undefined) : null,
        image: EGRESS_PROXY_IMAGE,
        version: getVersion(),
      })
    )
    .digest('hex')
    .slice(0, 20)
  return { key, name: `hammerkit-proxy-${key}`, sandbox }
}

// What the proxy's objects are labeled with: removed with the run, or, on a sandbox,
// with the pod of its files.
function getProxyLabels(
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  proxy: ProxyIdentity
): { [label: string]: string } {
  return {
    [NETWORK_OF_LABEL]: item.id(),
    ...(proxy.sandbox ? { [PROXY_OF_SANDBOX_LABEL]: proxy.sandbox.label } : getRunLabels(env)),
  }
}

export function getNetworkPolicyName(item: ContainerItem, scope: KubernetesNetworkScope): string {
  return `hammerkit-network-${getNetworkKey(item, scope)}`
}

// the pods of the item, of the run when the scope has one
function getItemPodLabels(item: ContainerItem, scope: KubernetesNetworkScope): { [key: string]: string } {
  return { [ID_LABEL]: item.id(), ...(scope.run ? { [RUN_LABEL]: scope.run } : {}) }
}

function toSelector(labels: { [key: string]: string }): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
}

// Who may connect to a limited item: the items that need it, and for a
// service a Gateway API route of the environment, the cluster's equivalent
// of a published port. A task takes no connections.
function getIngress(env: WorkKubernetesEnvironment, item: ContainerItem): V1NetworkPolicyIngressRule[] {
  if (!isContainerWorkService(item.data)) {
    return []
  }
  if (env.httpRoutes.some((route) => route.service === item.name)) {
    return [{}]
  }
  const ids = [...new Set(item.requiredBy.map((requirer) => requirer.id()))]
  if (ids.length === 0) {
    return []
  }
  const from: V1LabelSelector = { matchExpressions: [{ key: ID_LABEL, operator: 'In', values: ids }] }
  // the client's name for `from`, a reserved word
  return [{ _from: [{ podSelector: from }] }]
}

// The NetworkPolicy of a limited item: egress to the pods of the services it
// needs and, under `allow`, to its proxy; nothing else, DNS included (needs
// and the proxy are host aliases). Ingress only from what needs it. An open
// item has none.
export function buildNetworkPolicy(
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  network: WorkNetwork,
  scope: KubernetesNetworkScope,
  proxy: ProxyIdentity = getRunProxy(item, scope)
): V1NetworkPolicy & KubernetesObjectHeader {
  const needs = item.needs.filter((need) => isContainerWorkServiceItem(need.service))
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      namespace: env.namespace,
      name: getNetworkPolicyName(item, scope),
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: { [NETWORK_OF_LABEL]: item.id(), ...getRunLabels(env) },
    },
    spec: {
      podSelector: { matchLabels: getItemPodLabels(item, scope) },
      policyTypes: ['Ingress', 'Egress'],
      ingress: getIngress(env, item),
      egress: [
        ...(needs.length > 0
          ? [{ to: needs.map((need) => ({ podSelector: { matchLabels: { [ID_LABEL]: need.service.id() } } })) }]
          : []),
        ...(network.type === 'allow'
          ? [
              {
                to: [{ podSelector: { matchLabels: { [PROXY_LABEL]: proxy.key } } }],
                ports: getEgressProxyPorts(network).map((port) => ({ protocol: 'TCP', port })),
              },
            ]
          : []),
      ],
    },
  }
}

// The proxy takes connections from its item's pods only, so no other pod
// uses its allow list or reaches the item's services through it; a proxy that
// outlives its run, from the pods of the current run only.
export function buildProxyPolicy(
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  network: WorkNetwork,
  scope: KubernetesNetworkScope,
  proxy: ProxyIdentity = getRunProxy(item, scope)
): V1NetworkPolicy & KubernetesObjectHeader {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      namespace: env.namespace,
      name: proxy.name,
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: getProxyLabels(env, item, proxy),
      ...(proxy.owner ? { ownerReferences: [proxy.owner] } : {}),
    },
    spec: {
      podSelector: { matchLabels: { [PROXY_LABEL]: proxy.key } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          _from: [{ podSelector: { matchLabels: getItemPodLabels(item, scope) } }],
          ports: getEgressProxyPorts(network).map((port) => ({ protocol: 'TCP', port })),
        },
      ],
    },
  }
}

// What the item's pods are created with, after its policy (and proxy) are in
// place, so a pod never runs unlimited. A limited item needs an environment
// that states its cluster enforces NetworkPolicy: hammerkit can't tell from
// the API, and a policy nobody enforces would run the item open.
// An open service gets what it had before: whatever an earlier limited run
// left goes.
// A task follows the proxy's log while its jobs run. A service outlives the
// run on a cluster, so its refused hosts are in the proxy's own log.
export async function ensureKubernetesItemNetwork(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  options: { followLog: boolean } & KubernetesNetworkScope
): Promise<KubernetesItemNetwork> {
  const network = getEffectiveNetwork(item.data)
  if (network.type !== 'open' && !env.networkPolicyEnforced) {
    throw new Error(
      `${item.name}: network ${network.type} needs a cluster that enforces NetworkPolicy, ` +
        'state it with networkPolicy: enforced on the kubernetes environment'
    )
  }
  const hostAliases = await getNeedHostAliases(instance, env, item)
  if (network.type === 'open') {
    if (!options.run) {
      // without the rights to manage NetworkPolicies, hammerkit never made one
      await removeKubernetesItemNetwork(instance, env, item, { run: null }, { ignoreForbidden: true })
    }
    return { env: [], hostAliases, initContainers: [], close() {} }
  }

  const proxy =
    network.type === 'allow' && options.sandbox
      ? getSandboxProxy(env, item, network, hostAliases, options.sandbox)
      : getRunProxy(item, options)
  await apply(instance, buildNetworkPolicy(env, item, network, options, proxy))
  const initContainers = [getNetworkGateContainer()]
  if (network.type === 'none') {
    if (options.sandbox) {
      await removeSandboxProxies(instance, env.namespace, { sandbox: options.sandbox.label, item })
    } else {
      await removeProxy(instance, env.namespace, proxy.name, [404])
    }
    return { env: [], hostAliases, initContainers, close() {} }
  }

  let started: { ip: string; reused: boolean }
  try {
    if (proxy.sandbox) {
      // a proxy of the sandbox from before, made of something else, goes
      await removeSandboxProxies(
        instance,
        env.namespace,
        { sandbox: proxy.sandbox.label, item },
        (deployment) => deployment.metadata?.labels?.[PROXY_LABEL] === proxy.key
      )
      proxy.owner = await getFilesPodOwner(instance, env, proxy.sandbox)
    }
    started = await ensureProxy(instance, env, item, network, hostAliases, options, proxy)
  } catch (e) {
    await removeKubernetesItemNetwork(instance, env, item, options).catch(() => undefined)
    throw e
  }
  const follow = options.followLog
    ? await followProxyLog(instance, env, item, proxy, { tailLines: started.reused ? 0 : undefined })
    : null
  return {
    env: Object.entries(getProxyClientEnvironment(item.needs.map((need) => need.name))).map(([name, value]) => ({
      name,
      value,
    })),
    // the item reaches each TCP forward under its host's name, at the proxy
    hostAliases: [
      ...hostAliases,
      { ip: started.ip, hostnames: [EGRESS_PROXY_HOST, ...getTcpForwards(network).map((forward) => forward.host)] },
    ],
    initContainers,
    close: () => follow?.abort(),
  }
}

// The policy and proxy of the scope go only once no pod of it runs anymore:
// a pod that is still terminating (cancel, timeout, `down`) would otherwise
// run without limits. When pods outlast the wait, the policy stays.
// The proxy of a task on a sandbox stays while the pod of the sandbox's files
// runs, which owns it; one it does not own goes with the run.
export async function removeKubernetesItemNetwork(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  scope: KubernetesNetworkScope,
  options: { ignoreForbidden: boolean } = { ignoreForbidden: false }
): Promise<void> {
  const ignored = options.ignoreForbidden ? [403, 404] : [404]
  await ignoreStatus(
    instance.objectApi.delete({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: getNetworkPolicyName(item, scope), namespace: env.namespace },
    }),
    ignored
  )
  if (scope.sandbox) {
    const owner = await getFilesPodOwner(instance, env, scope.sandbox)
    await removeSandboxProxies(instance, env.namespace, { sandbox: scope.sandbox.label, item }, (deployment) =>
      (deployment.metadata?.ownerReferences ?? []).some((reference) => !!owner && reference.uid === owner.uid)
    )
  } else {
    await removeProxy(instance, env.namespace, getProxyName(item, scope), ignored)
  }
}

// Waits until no pod with the labels runs or waits to run.
export async function awaitPodsEnded(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  labels: { [key: string]: string },
  timeout = POD_END_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeout
  for (;;) {
    const pods = await instance.coreApi.listNamespacedPod({
      namespace: env.namespace,
      labelSelector: toSelector(labels),
    })
    if (pods.items.every((pod) => pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed')) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await sleep(POD_END_POLL_MS)
  }
}

// Removes the scope's policy and proxy once its pods ended.
export async function releaseKubernetesItemNetwork(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  scope: KubernetesNetworkScope
): Promise<void> {
  if (!(await awaitPodsEnded(instance, env, getItemPodLabels(item, scope)))) {
    throw new Error(`pods of ${item.name} are still running, so its network policy stays`)
  }
  await removeKubernetesItemNetwork(instance, env, item, scope)
}

// Every policy and proxy of the item, of any run, once none of its pods runs:
// what `down` and `clean` remove.
export async function removeAllKubernetesItemNetworks(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem
): Promise<void> {
  if (!(await awaitPodsEnded(instance, env, { [ID_LABEL]: item.id() }))) {
    throw new Error(`pods of ${item.name} are still running, so its network policy stays`)
  }
  const labelSelector = `${NETWORK_OF_LABEL}=${item.id()}`
  let policies: V1NetworkPolicy[]
  try {
    const list = await instance.objectApi.list<V1NetworkPolicy & KubernetesObjectHeader>(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      env.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    )
    policies = list.items
  } catch (e) {
    // without the rights to manage NetworkPolicies, hammerkit never made one
    if (statusCodeOf(e) === 403) {
      return
    }
    throw e
  }
  // the items of a list carry no kind of their own
  for (const name of policies.map((policy) => policy.metadata?.name).filter((name): name is string => !!name)) {
    await ignoreStatus(
      instance.objectApi.delete({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name, namespace: env.namespace },
      }),
      [404]
    )
  }
  const deployments = await instance.appsApi.listNamespacedDeployment({ namespace: env.namespace, labelSelector })
  for (const deployment of deployments.items) {
    const name = deployment.metadata?.name
    if (name) {
      await ignoreStatus(instance.appsApi.deleteNamespacedDeployment({ name, namespace: env.namespace }), [404])
      await ignoreStatus(instance.coreApi.deleteNamespacedService({ name, namespace: env.namespace }), [404])
    }
  }
}

// the services the item needs, by the names it lists them under
async function getNeedHostAliases(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem
): Promise<V1HostAlias[]> {
  const hostAliases: V1HostAlias[] = []
  for (const need of item.needs) {
    if (!isContainerWorkServiceItem(need.service)) {
      continue
    }
    const ip = await getServiceIp(instance, env, need.service)
    if (!ip) {
      throw new Error(`unable to get service ip for ${need.name}`)
    }
    hostAliases.push({ ip, hostnames: [need.name] })
  }
  return hostAliases
}

// The proxy as a Deployment and a Service; its pods reach out without an
// egress policy of their own, and reach the needed services by name for tools
// that ignore NO_PROXY. Unprivileged, from a pinned image. Its Service carries
// the port of each TCP forward too.
// Exits 0 once every port answers on the pod's loopback.
export function getProxyReadinessScript(ports: number[]): string {
  return (
    `const net = require('net'); let open = ${ports.length}; ` +
    `for (const port of ${JSON.stringify(ports)}) net.connect(port, '127.0.0.1')` +
    `.on('connect', function () { this.destroy(); if (--open === 0) process.exit(0) })` +
    `.on('error', () => process.exit(1))`
  )
}

async function ensureProxy(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  network: Extract<WorkNetwork, { type: 'allow' }>,
  hostAliases: V1HostAlias[],
  scope: KubernetesNetworkScope,
  proxy: ProxyIdentity
): Promise<{ ip: string; reused: boolean }> {
  const name = proxy.name
  const labels = { [PROXY_LABEL]: proxy.key }
  const metadata = {
    namespace: env.namespace,
    name,
    annotations: { 'hammerkit.dev/version': getVersion() },
    labels: { ...labels, ...getProxyLabels(env, item, proxy) },
    ...(proxy.owner ? { ownerReferences: [proxy.owner] } : {}),
  }
  // on a server the proxy runs on the nodes of the first pool
  const placement = env.server ? getPodPlacement(env.server, undefined) : null
  const deployment: V1Deployment & KubernetesObjectHeader = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata,
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: {
          labels: {
            ...labels,
            ...(proxy.sandbox ? {} : getRunLabels(env)),
            ...(env.server ? { [NETWORK_LABEL]: 'proxy' } : {}),
          },
        },
        spec: {
          hostAliases,
          automountServiceAccountToken: false,
          ...(placement ? { nodeSelector: placement.nodeSelector, tolerations: placement.tolerations } : {}),
          // unprivileged, it still listens on the port of a TCP forward below
          // 1024; a sysctl every Pod Security level allows
          securityContext: { sysctls: [{ name: 'net.ipv4.ip_unprivileged_port_start', value: '0' }] },
          containers: [
            {
              name: 'proxy',
              image: EGRESS_PROXY_IMAGE,
              command: getEgressProxyCommand(),
              env: Object.entries(getItemProxyEnvironment(item)).map(([key, value]) => ({ name: key, value })),
              ports: getEgressProxyPorts(network).map((port) => ({ containerPort: port })),
              // in the pod, since its ingress policy may keep the kubelet out;
              // ready once it listens on every port, its TCP forwards' too
              readinessProbe: {
                exec: {
                  command: ['node', '-e', getProxyReadinessScript(getEgressProxyPorts(network))],
                },
                periodSeconds: 2,
              },
              securityContext: HELPER_SECURITY_CONTEXT,
              resources: { limits: { memory: '256Mi' } },
            },
          ],
        },
      },
    },
  }
  const service: V1Service & KubernetesObjectHeader = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata,
    spec: {
      type: 'ClusterIP',
      selector: labels,
      ports: getEgressProxyPorts(network).map((port) => ({ name: `tcp-${port}`, port, targetPort: port })),
    },
  }
  // on a sandbox, the proxy of an earlier run may still be there: the item's policy
  // of this run lets its pods reach it, its own policy lets them in
  const reused = proxy.sandbox
    ? await instance.objectApi.read(deployment).then(
        (current) => !current.metadata?.deletionTimestamp,
        (e) => (statusCodeOf(e) === 404 ? false : Promise.reject(e))
      )
    : false
  await apply(instance, buildProxyPolicy(env, item, network, scope, proxy))
  await apply(instance, deployment)
  const created = await apply(instance, service)
  await awaitDeployRunningState(instance, env, name, {
    podSelector: toSelector(labels),
    timeout: PROXY_READY_TIMEOUT_MS,
    timeoutMessage: `the egress proxy of ${item.name} did not start`,
  })
  const ip = created.spec?.clusterIP
  if (!ip) {
    throw new Error(`the egress proxy of ${item.name} has no cluster ip`)
  }
  item.status.write(
    'debug',
    `${reused ? 'egress proxy of the sandbox' : 'egress proxy'} allows ${network.hosts.join(', ') || 'no host'}`
  )
  return { ip, reused }
}

// Refused hosts show up in the item's log, as on Docker; of a proxy from an
// earlier run (`tailLines: 0`), only what this run asks of it.
async function followProxyLog(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  item: ContainerItem,
  proxy: ProxyIdentity,
  options: { tailLines?: number }
): Promise<AbortController | null> {
  try {
    const pods = await instance.coreApi.listNamespacedPod({
      namespace: env.namespace,
      labelSelector: `${PROXY_LABEL}=${proxy.key}`,
    })
    const pod = pods.items.find((p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp)
    if (!pod?.metadata?.name) {
      return null
    }
    const output = new PassThrough()
    // close() aborts the request, which errors the response stream the
    // client pipes in here; nothing listens to it there
    output.on('pipe', (source) => source.on('error', () => undefined))
    createInterface({ input: output }).on('line', (line) => {
      const event = parseEgressProxyEvent(line)
      if (event && event.type !== 'ready') {
        item.status.write('warn', formatEgressProxyEvent(event))
      }
    })
    return await instance.log.log(env.namespace, pod.metadata.name, 'proxy', output as Writable, {
      follow: true,
      ...(options.tailLines !== undefined ? { tailLines: options.tailLines } : {}),
    })
  } catch (e) {
    item.status.write('debug', `unable to follow the egress proxy log: ${getErrorMessage(e)}`)
    return null
  }
}

async function removeProxy(instance: KubernetesInstance, namespace: string, name: string, ignored: number[]) {
  await ignoreStatus(instance.appsApi.deleteNamespacedDeployment({ name, namespace }), ignored)
  await ignoreStatus(instance.coreApi.deleteNamespacedService({ name, namespace }), ignored)
  await ignoreStatus(
    instance.objectApi.delete({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name, namespace },
    }),
    ignored
  )
}

// The proxies on the sandbox, of the item when one is given, but those `keep` takes.
// The cluster removes those the pod of the sandbox's files owns when the pod goes; the
// server removes all when it took the pod away while a run worked (see
// KubernetesSandboxStorage.makeWayForRun).
export async function removeSandboxProxies(
  instance: KubernetesInstance,
  namespace: string,
  of: { sandbox: string; item?: ContainerItem },
  keep: (deployment: V1Deployment) => boolean = () => false
): Promise<void> {
  const deployments = await instance.appsApi.listNamespacedDeployment({
    namespace,
    labelSelector: [
      `${PROXY_OF_SANDBOX_LABEL}=${of.sandbox}`,
      ...(of.item ? [`${NETWORK_OF_LABEL}=${of.item.id()}`] : []),
    ].join(','),
  })
  for (const deployment of deployments.items) {
    const name = deployment.metadata?.name
    if (name && !keep(deployment)) {
      await removeProxy(instance, namespace, name, [404])
    }
  }
}

// The pod of the sandbox's files the run holds, as the owner of the proxy: the cluster
// removes the proxy when that pod goes. None when the pod is no longer the one the run
// holds (it made way for a pod of the run): the proxy then goes with the run.
async function getFilesPodOwner(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  sandbox: KubernetesSandboxScope
): Promise<V1OwnerReference | undefined> {
  if (!sandbox.pod) {
    return undefined
  }
  const { name, uid } = sandbox.pod
  const current = await instance.coreApi
    .readNamespacedPod({ name, namespace: env.namespace })
    .catch((e) => (statusCodeOf(e) === 404 ? undefined : Promise.reject(e)))
  if (!current || current.metadata?.uid !== uid || current.metadata?.deletionTimestamp) {
    return undefined
  }
  return { apiVersion: 'v1', kind: 'Pod', name, uid }
}

async function ignoreStatus(promise: Promise<unknown>, statusCodes: number[]): Promise<void> {
  try {
    await promise
  } catch (e) {
    if (!statusCodes.includes(statusCodeOf(e) ?? 0)) {
      throw e
    }
  }
}
