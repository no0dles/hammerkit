import { createServer, Server, Socket } from 'net'
import { AppsV1Api, CoreV1Api, KubeConfig, PortForward } from '@kubernetes/client-node'
import { Writable, Readable } from 'stream'
import { getErrorMessage } from '../log'
import { WorkItem } from '../planner/work-item'
import { KubernetesWorkService } from '../planner/work-service'
import { ServiceState } from './scheduler/service-state'
import { ExecuteOptions } from '../runtime/runtime'
import { resolvePodName } from '../kubernetes/resolve-pod-name'

function loadKubeConfig(service: KubernetesWorkService): KubeConfig {
  const kc = new KubeConfig()
  if (service.kubeconfig) {
    kc.loadFromFile(service.kubeconfig)
  } else {
    kc.loadFromDefault()
  }
  kc.setCurrentContext(service.context)
  return kc
}

interface ForwardServer {
  hostPort: number
  containerPort: number
  server: Server
  sockets: Set<Socket>
}

async function startForwardServer(
  forward: PortForward,
  namespace: string,
  podName: string,
  hostPort: number,
  containerPort: number,
  item: WorkItem<KubernetesWorkService>
): Promise<ForwardServer> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    // retryCount=0 selects PortForward's non-restartable input path: a simple
    // synchronous ws.send per chunk. The retryCount=1 path uses
    // restartableHandleStandardInput, whose internal `queue.then(...)` chain has
    // NO `.catch` (see web-socket-handler.js processData TODO) so a closed WS
    // becomes an unhandled rejection ("can't send data to ws") that crashes the
    // whole process. We catch ws errors/close ourselves and close both sides
    // together so the event loop drains on teardown.
    let ws: { close?: () => void } | null = null
    socket.on('close', () => {
      sockets.delete(socket)
      try {
        ws?.close?.()
      } catch {
        /* already closing */
      }
    })
    socket.on('error', (err) => {
      item.status.write('debug', `port-forward socket error: ${getErrorMessage(err)}`)
    })
    forward
      .portForward(namespace, podName, [containerPort], socket as Writable, null, socket as Readable, 0)
      .then((opened) => {
        ws = opened as unknown as { close?: () => void }
        const w = ws as { on?: (evt: string, cb: (err?: unknown) => void) => void }
        w?.on?.('error', (err) => {
          item.status.write('debug', `port-forward ws error: ${getErrorMessage(err)}`)
          socket.destroy()
        })
        w?.on?.('close', () => socket.destroy())
      })
      .catch((err) => {
        item.status.write('error', `port-forward failed: ${getErrorMessage(err)}`)
        socket.destroy()
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(hostPort, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  return { hostPort, containerPort, server, sockets }
}

function closeForwardServer(fs: ForwardServer): Promise<void> {
  for (const socket of fs.sockets) {
    socket.destroy()
  }
  return new Promise((resolve) => {
    fs.server.close(() => resolve())
  })
}

export async function kubernetesService(
  service: WorkItem<KubernetesWorkService>,
  options: ExecuteOptions<ServiceState>
): Promise<void> {
  const kc = loadKubeConfig(service.data)
  const forward = new PortForward(kc)
  const coreApi = kc.makeApiClient(CoreV1Api)
  const appsApi = kc.makeApiClient(AppsV1Api)

  let podName: string
  try {
    podName = await resolvePodName(coreApi, appsApi, service.data.namespace, service.data.selector)
  } catch (e) {
    service.status.write('error', getErrorMessage(e))
    options.state.set({
      type: 'error',
      stateKey: options.stateKey,
      errorMessage: getErrorMessage(e),
    })
    return
  }

  const servers: ForwardServer[] = []
  try {
    for (const port of service.data.ports) {
      if (port.hostPort === null) {
        continue
      }
      const fs = await startForwardServer(
        forward,
        service.data.namespace,
        podName,
        port.hostPort,
        port.containerPort,
        service
      )
      servers.push(fs)
      service.status.write('info', `forwarding 127.0.0.1:${port.hostPort} -> ${podName}:${port.containerPort}`)
    }
  } catch (e) {
    service.status.write('error', `failed to start port-forward: ${getErrorMessage(e)}`)
    await Promise.all(servers.map(closeForwardServer))
    options.state.set({ type: 'error', stateKey: options.stateKey, errorMessage: getErrorMessage(e) })
    return
  }

  options.state.set({
    type: 'running',
    dns: { host: '127.0.0.1' },
    stateKey: options.stateKey,
    remote: null,
  })

  try {
    await new Promise<void>((resolve) => {
      if (options.abort.aborted) {
        resolve()
        return
      }
      options.abort.addEventListener('abort', () => resolve(), { once: true })
    })
  } finally {
    await Promise.all(servers.map(closeForwardServer))
    options.state.set({ type: 'end', reason: 'terminated', stateKey: options.stateKey })
  }
}
