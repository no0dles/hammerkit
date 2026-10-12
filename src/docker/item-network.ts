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
import { pull } from './pull'
import { removeContainer } from './remove-container'
import {
  EGRESS_PROXY_HOST,
  EGRESS_PROXY_IMAGE,
  formatRefusedHost,
  getEgressProxyCommand,
  getEgressProxyEnvironment,
  getProxyClientEnvironment,
  parseEgressProxyEvent,
} from '../network/egress-proxy'
import { getErrorMessage } from '../log'
import { sleep } from '../utils/sleep'
import { isDockerUnreachable, isOfStoppedRun, isProcessAlive } from './remove-orphaned-containers'

const PROXY_READY_TIMEOUT_MS = 60000
const NETWORK_REMOVE_ATTEMPTS = 20

type ContainerItem = WorkItem<ContainerWorkTask | ContainerWorkService>

// What the container is created with: its network mode (the default bridge
// when unset), links to services on the default bridge, host entries for
// services on the host and the proxy variables under `allow`.
export interface ContainerNetworkOptions {
  mode?: string
  links?: string[]
  hosts?: string[]
  env?: { [key: string]: string }
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
// when it needs a service or allows hosts.
export function getItemNetworkName(item: ContainerItem): string {
  return `hammerkit-${getWorkInstanceId(item)}`
}

// Where the container of a service is reached: on the default bridge (open)
// or on its own internal network (limited).
function getNeedNetwork(need: WorkItemNeed): string | null {
  const service = need.service
  if (!isContainerWorkService(service.data)) {
    return null
  }
  return isLimitedNetwork(getEffectiveNetwork(service.data))
    ? getItemNetworkName(service as WorkItem<ContainerWorkService>)
    : null
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
  options: { daemon: boolean }
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
      containers.push({ need, containerId: target.containerId, network: getNeedNetwork(need) })
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

  const name = getItemNetworkName(item)
  await removeItemNetwork(docker, name)
  await docker.createNetwork({
    Name: name,
    Internal: true,
    Labels: {
      app: 'hammerkit',
      'hammerkit-network-of': getWorkInstanceId(item),
      ...getRunLabels(),
      'hammerkit-daemon': options.daemon ? 'true' : 'false',
    },
  })
  try {
    for (const target of containers) {
      await docker.getNetwork(name).connect({
        Container: target.containerId,
        EndpointConfig: { Aliases: [target.need.name] },
      })
    }
    if (network.type === 'allow') {
      await startEgressProxy(docker, item, environment, name, network, options)
    }
  } catch (e) {
    await removeItemNetwork(docker, name)
    throw e
  }

  return {
    options: {
      mode: name,
      hosts,
      env: network.type === 'allow' ? getProxyClientEnvironment(item.needs.map((need) => need.name)) : {},
    },
    async connect() {},
    async release() {
      await removeItemNetwork(docker, name)
    },
  }
}

// Connected to the item's network under EGRESS_PROXY_HOST, and to the default
// bridge for the way out. Refused hosts show up in the item's log.
async function startEgressProxy(
  docker: Dockerode,
  item: ContainerItem,
  environment: Environment,
  networkName: string,
  network: Extract<WorkNetwork, { type: 'allow' }>,
  options: { daemon: boolean }
): Promise<void> {
  await pull(item.status, docker, EGRESS_PROXY_IMAGE, environment)
  const createOptions: ContainerCreateOptions = {
    Image: EGRESS_PROXY_IMAGE,
    Cmd: getEgressProxyCommand(),
    // the needed services too, for tools that ignore NO_PROXY
    Env: Object.entries(getEgressProxyEnvironment([...network.hosts, ...item.needs.map((need) => need.name)])).map(
      ([key, value]) => `${key}=${value}`
    ),
    Labels: {
      app: 'hammerkit',
      'hammerkit-type': 'proxy',
      'hammerkit-network': networkName,
      ...getRunLabels(),
      'hammerkit-daemon': options.daemon ? 'true' : 'false',
    },
  }
  const container = await docker.createContainer(createOptions)
  await docker.getNetwork(networkName).connect({
    Container: container.id,
    EndpointConfig: { Aliases: [EGRESS_PROXY_HOST] },
  })
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

// The network, its proxy and every endpoint on it: what an earlier run left
// behind, or what the item used.
export async function removeItemNetwork(docker: Dockerode, name: string): Promise<void> {
  const proxies = await docker.listContainers({ all: true, filters: { label: [`hammerkit-network=${name}`] } })
  for (const proxy of proxies) {
    await removeContainer(docker.getContainer(proxy.Id))
  }
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
