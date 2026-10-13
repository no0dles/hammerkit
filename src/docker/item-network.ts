import Dockerode, { Container, ContainerCreateOptions } from 'dockerode'
import { createInterface } from 'readline'
import { PassThrough } from 'stream'
import { WorkItem, WorkItemNeed } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService, isContainerWorkService } from '../planner/work-service'
import { getEffectiveNetwork, isLimitedNetwork, WorkNetwork } from '../planner/work-network'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { getServiceContainers } from '../executer/get-service-containers'
import { isHostServiceDns } from '../executer/service-dns'
import { Environment } from '../executer/environment'
import { getRunLabels } from './run-labels'
import { getRunId } from '../utils/run-id'
import { pull } from './pull'
import { removeContainer } from './remove-container'
import {
  EGRESS_PROXY_HOST,
  EGRESS_PROXY_IMAGE,
  formatRefusedHost,
  getEgressProxyCommand,
  getItemProxyEnvironment,
  getProxyClientEnvironment,
  parseEgressProxyEvent,
} from '../network/egress-proxy'
import { getPortRelayCommand, getPortRelayEnvironment } from '../network/port-relay'
import { WorkPort } from '../planner/work-port'
import { getErrorMessage } from '../log'
import { sleep } from '../utils/sleep'
import { isDockerUnreachable, isOfStoppedRun, isProcessAlive } from './remove-orphaned-containers'

const PROXY_READY_TIMEOUT_MS = 60000
const NETWORK_REMOVE_ATTEMPTS = 20
// the first release with com.docker.network.bridge.inhibit_ipv4, which keeps
// an internal network from reaching the host through its gateway; it also
// has the fix for CVE-2024-29018 (DNS forwarded from internal networks)
const MIN_DOCKER_MAJOR = 28

type ContainerItem = WorkItem<ContainerWorkTask | ContainerWorkService>

// What the container is created with: its network mode (the default bridge
// when unset), links to services on the default bridge, host entries for
// services on the host and the proxy variables under `allow`.
export interface ContainerNetworkOptions {
  mode?: string
  links?: string[]
  hosts?: string[]
  env?: { [key: string]: string }
  // a limited service's ports are published by a relay, not by its container
  relayPorts?: boolean
}

export interface DockerItemNetwork {
  options: ContainerNetworkOptions
  // joins the networks of limited services the item needs; after the
  // container was created, before anything runs in it
  connect(container: Container): Promise<void>
  // removes the item's network and proxy once its container is gone
  release(): Promise<void>
}

// The internal network of a task or service with a limited network. Services
// always have one when limited, since what needs them joins it; a task only
// when it needs a service or allows hosts. The name carries the run, so
// concurrent runs never share or remove each other's networks.
export function getItemNetworkName(item: ContainerItem): string {
  return `hammerkit-${getWorkInstanceId(item)}-${getRunId()}`
}

// The network between an `allow` item and its proxy, which nothing else joins:
// the services the item needs don't get to use its proxy.
export function getProxyNetworkName(networkName: string): string {
  return `${networkName}-proxy`
}

const daemonVersions = new WeakMap<Dockerode, Promise<{ Version: string; Os: string }>>()

// Limits rely on internal networks without a gateway on the host, which only
// Linux containers on Docker 28 or later have. Anything else would run the
// item with a hole, so it is refused.
export async function checkNetworkLimitSupport(docker: Dockerode, item: ContainerItem): Promise<void> {
  let version = daemonVersions.get(docker)
  if (!version) {
    version = docker.version()
    daemonVersions.set(docker, version)
  }
  const { Version, Os } = await version
  const level = getEffectiveNetwork(item.data).type
  if (Os !== 'linux') {
    throw new Error(`${item.name}: network ${level} needs Linux containers, the docker daemon runs ${Os} containers`)
  }
  const major = parseInt(Version, 10)
  if (!(major >= MIN_DOCKER_MAJOR)) {
    throw new Error(
      `${item.name}: network ${level} needs Docker ${MIN_DOCKER_MAJOR} or later, the daemon is ${Version}`
    )
  }
}

// Internal (no route out) and without an address on the host, so the host's
// services can't be reached through it either.
async function createInternalNetwork(
  docker: Dockerode,
  name: string,
  labels: { [key: string]: string }
): Promise<void> {
  await docker.createNetwork({
    Name: name,
    Internal: true,
    Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
    Labels: labels,
  })
}

// What the proxy and relay may do: serve, nothing else.
const HELPER_HOST_CONFIG = {
  CapDrop: ['ALL'],
  SecurityOpt: ['no-new-privileges'],
  ReadonlyRootfs: true,
  Memory: 256 * 1024 * 1024,
  PidsLimit: 64,
}

// Where the container of a service is reached: on the default bridge (open)
// or on its own internal network (limited), which may be of an earlier run
// (`up --daemon`).
async function getNeedNetwork(docker: Dockerode, need: WorkItemNeed, containerId: string): Promise<string | null> {
  const service = need.service
  if (!isContainerWorkService(service.data) || !isLimitedNetwork(getEffectiveNetwork(service.data))) {
    return null
  }
  const info = await docker.getContainer(containerId).inspect()
  return info.HostConfig.NetworkMode ?? null
}

// Docker options for the network of a task or service. `open` is the default
// bridge with links to the needed services, as before network limits. `none`
// and `allow` put the container on an internal network of its own (or none at
// all for a task that needs nothing) that the needed services join under the
// names it needs them by; `allow` adds the egress proxy to it.
export async function prepareItemNetwork(
  docker: Dockerode,
  item: ContainerItem,
  environment: Environment,
  // `publish`: the ports a service publishes on the host
  options: { daemon: boolean; publish?: WorkPort[] }
): Promise<DockerItemNetwork> {
  const network = getEffectiveNetwork(item.data)
  const dns = getServiceContainers(item.needs)
  const hosts: string[] = []
  const containers: { need: WorkItemNeed; containerId: string; network: string | null }[] = []
  for (const need of item.needs) {
    const target = dns[need.name]
    if (!target || (!isHostServiceDns(target) && !target.containerId)) {
      throw new Error(`service ${need.name} is not running`)
    }
    if (isHostServiceDns(target)) {
      hosts.push(`${need.name}:${target.host}`)
    } else {
      containers.push({
        need,
        containerId: target.containerId,
        network: await getNeedNetwork(docker, need, target.containerId),
      })
    }
  }

  if (!isLimitedNetwork(network)) {
    return {
      options: {
        links: containers.filter((c) => !c.network).map((c) => `${c.containerId}:${c.need.name}`),
        hosts,
      },
      // a limited service is on its internal network only, so an open item
      // joins that network to reach it
      async connect(container: Container) {
        for (const target of containers) {
          if (target.network) {
            // a link on a user-defined network resolves by container name only
            const info = await docker.getContainer(target.containerId).inspect()
            await docker.getNetwork(target.network).connect({
              Container: container.id,
              EndpointConfig: { Links: [`${info.Name.replace(/^\//, '')}:${target.need.name}`] },
            })
          }
        }
      },
      async release() {},
    }
  }

  if (network.type === 'none' && containers.length === 0 && !isContainerWorkService(item.data)) {
    return {
      options: { mode: 'none' },
      async connect() {},
      async release() {},
    }
  }

  await checkNetworkLimitSupport(docker, item)
  const name = getItemNetworkName(item)
  const labels = {
    app: 'hammerkit',
    'hammerkit-network-of': getWorkInstanceId(item),
    ...getRunLabels(),
    'hammerkit-daemon': options.daemon ? 'true' : 'false',
  }
  await createInternalNetwork(docker, name, labels)
  try {
    for (const target of containers) {
      await docker.getNetwork(name).connect({
        Container: target.containerId,
        EndpointConfig: { Aliases: [target.need.name] },
      })
    }
    if (network.type === 'allow') {
      await createInternalNetwork(docker, getProxyNetworkName(name), labels)
      await startEgressProxy(docker, item, environment, name, network, options, containers.length > 0)
    }
  } catch (e) {
    await removeItemNetwork(docker, name)
    throw e
  }

  const publish = (options.publish ?? []).filter((port) => !!port.hostPort)
  return {
    options: {
      mode: name,
      hosts,
      env: network.type === 'allow' ? getProxyClientEnvironment(item.needs.map((need) => need.name)) : {},
      relayPorts: isContainerWorkService(item.data),
    },
    async connect(container: Container) {
      try {
        if (network.type === 'allow') {
          await docker.getNetwork(getProxyNetworkName(name)).connect({ Container: container.id })
        }
        if (publish.length > 0) {
          await startPortRelay(docker, item, environment, name, container, publish, options)
        }
      } catch (e) {
        await removeItemNetwork(docker, name)
        throw e
      }
    },
    async release() {
      await removeItemNetwork(docker, name)
    },
  }
}

function getHelperLabels(networkName: string, options: { daemon: boolean }): { [key: string]: string } {
  return {
    app: 'hammerkit',
    // goes with the task or service it serves
    'hammerkit-type': 'proxy',
    'hammerkit-network': networkName,
    ...getRunLabels(),
    'hammerkit-daemon': options.daemon ? 'true' : 'false',
  }
}

// On the default bridge for the way out, and on the proxy network under
// EGRESS_PROXY_HOST, the only address it listens on: neither the bridge nor
// the services on the item's network reach it. It joins the item's network
// to reach the needed services (for tools that ignore NO_PROXY), but doesn't
// listen there. Refused hosts show up in the item's log.
async function startEgressProxy(
  docker: Dockerode,
  item: ContainerItem,
  environment: Environment,
  networkName: string,
  network: Extract<WorkNetwork, { type: 'allow' }>,
  options: { daemon: boolean },
  reachNeeds: boolean
): Promise<void> {
  await pull(item.status, docker, EGRESS_PROXY_IMAGE, environment)
  const createOptions: ContainerCreateOptions = {
    Image: EGRESS_PROXY_IMAGE,
    Cmd: getEgressProxyCommand(),
    User: 'node',
    Env: Object.entries(getItemProxyEnvironment(item, EGRESS_PROXY_HOST)).map(([key, value]) => `${key}=${value}`),
    Labels: getHelperLabels(networkName, options),
    HostConfig: HELPER_HOST_CONFIG,
  }
  const container = await docker.createContainer(createOptions)
  await docker.getNetwork(getProxyNetworkName(networkName)).connect({
    Container: container.id,
    EndpointConfig: { Aliases: [EGRESS_PROXY_HOST] },
  })
  if (reachNeeds) {
    await docker.getNetwork(networkName).connect({ Container: container.id })
  }
  const stream = await container.attach({ stream: true, stdout: true, stderr: true })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  docker.modem.demuxStream(stream as any, stdout, stderr)
  stream.on('end', () => {
    stdout.end()
    stderr.end()
  })
  stderr.on('data', (data: Buffer) => item.status.write('debug', `proxy: ${data.toString().trim()}`))

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('the egress proxy did not start')), PROXY_READY_TIMEOUT_MS)
    const lines = createInterface({ input: stdout })
    lines.on('line', (line) => {
      const event = parseEgressProxyEvent(line)
      if (event?.type === 'ready') {
        clearTimeout(timeout)
        resolve()
      } else if (event?.type === 'refused') {
        item.status.write('warn', formatRefusedHost(event.host))
      }
    })
    lines.on('close', () => {
      clearTimeout(timeout)
      reject(new Error('the egress proxy stopped'))
    })
  })
  // once ready, a later close only means the proxy was removed with the item
  ready.catch(() => undefined)

  await container.start()
  await ready
  item.status.write('debug', `egress proxy allows ${network.hosts.join(', ') || 'no host'}`)
}

// On the default bridge, where Docker publishes ports, and on the service's
// network, from where it passes connections on to the service.
async function startPortRelay(
  docker: Dockerode,
  item: ContainerItem,
  environment: Environment,
  networkName: string,
  service: Container,
  ports: WorkPort[],
  options: { daemon: boolean }
): Promise<void> {
  await pull(item.status, docker, EGRESS_PROXY_IMAGE, environment)
  // a container is found by its name on a user-defined network
  const host = (await service.inspect()).Name.replace(/^\//, '')
  const container = await docker.createContainer({
    Image: EGRESS_PROXY_IMAGE,
    Cmd: getPortRelayCommand(),
    User: 'node',
    Env: Object.entries(
      getPortRelayEnvironment(ports.map((port) => ({ port: port.containerPort, host, targetPort: port.containerPort })))
    ).map(([key, value]) => `${key}=${value}`),
    Labels: getHelperLabels(networkName, options),
    ExposedPorts: Object.fromEntries(ports.map((port) => [`${port.containerPort}/tcp`, {}])),
    HostConfig: {
      ...HELPER_HOST_CONFIG,
      PortBindings: Object.fromEntries(
        ports.map((port) => [`${port.containerPort}/tcp`, [{ HostPort: `${port.hostPort}` }]])
      ),
    },
  })
  await docker.getNetwork(networkName).connect({ Container: container.id })
  await container.start()
  item.status.write('debug', `ports ${ports.map((port) => port.hostPort).join(', ')} published by a relay`)
}

// The network, its proxy network, its proxy and relay, and every endpoint on
// them: what an earlier run left behind, or what the item used.
export async function removeItemNetwork(docker: Dockerode, name: string): Promise<void> {
  const helpers = await docker.listContainers({ all: true, filters: { label: [`hammerkit-network=${name}`] } })
  for (const helper of helpers) {
    await removeContainer(docker.getContainer(helper.Id))
  }
  await removeNetwork(docker, getProxyNetworkName(name))
  await removeNetwork(docker, name)
}

async function removeNetwork(docker: Dockerode, name: string): Promise<void> {
  const network = docker.getNetwork(name)
  let info: { Containers?: { [id: string]: unknown } }
  try {
    info = await network.inspect()
  } catch (e: any) {
    if (e?.statusCode === 404) {
      return
    }
    throw e
  }
  for (const containerId of Object.keys(info.Containers ?? {})) {
    try {
      await network.disconnect({ Container: containerId, Force: true })
    } catch {
      // gone already, or on its way out with its container
    }
  }
  // a container being removed leaves its endpoints a moment later
  for (let attempt = 1; ; attempt++) {
    try {
      await network.remove()
      return
    } catch (e: any) {
      if (e?.statusCode === 404) {
        return
      }
      if (attempt >= NETWORK_REMOVE_ATTEMPTS) {
        throw new Error(`unable to remove network ${name}: ${getErrorMessage(e)}`)
      }
      await sleep(500)
    }
  }
}

export function getNetworkHostConfig(network: ContainerNetworkOptions): {
  NetworkMode?: string
  Links: string[]
  ExtraHosts: string[]
} {
  return {
    ...(network.mode ? { NetworkMode: network.mode } : {}),
    Links: network.links ?? [],
    ExtraHosts: network.hosts ?? [],
  }
}

// Every network of the item, of this run or another one: what `down` and
// `clean` remove.
export async function removeItemNetworks(docker: Dockerode, item: ContainerItem): Promise<void> {
  const networks = await docker.listNetworks({
    filters: { label: [`hammerkit-network-of=${getWorkInstanceId(item)}`] },
  })
  for (const network of networks) {
    await removeItemNetwork(docker, network.Name)
  }
}

// The internal networks of tasks and services a run left behind when it was
// killed. Networks of `up --daemon` services stay until `down`.
export async function removeOrphanedNetworks(docker: Dockerode): Promise<string[]> {
  let networks: { Name: string; Labels?: { [key: string]: string } }[]
  try {
    networks = await docker.listNetworks({ filters: { label: ['app=hammerkit'] } })
  } catch (e) {
    if (isDockerUnreachable(e)) {
      return []
    }
    throw e
  }
  const orphaned = networks.filter((network) => isOfStoppedRun(network.Labels ?? {}, isProcessAlive))
  for (const network of orphaned) {
    await removeItemNetwork(docker, network.Name)
  }
  return orphaned.map((network) => network.Name)
}
