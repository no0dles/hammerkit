import * as net from 'net'
import { kubernetesService } from './kubernetes-service'
import { State } from './state'
import { ServiceState } from './scheduler/service-state'
import { ExecuteOptions } from '../runtime/runtime'
import { WorkItem } from '../planner/work-item'
import { KubernetesWorkService } from '../planner/work-service'
import { resolvePodName } from '../kubernetes/resolve-pod-name'

const hoisted = vi.hoisted(() => ({
  loadFromFile: vi.fn(),
  loadFromDefault: vi.fn(),
  setCurrentContext: vi.fn(),
  makeApiClient: vi.fn(() => ({})),
  portForward: vi.fn(),
}))

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromFile = hoisted.loadFromFile
    loadFromDefault = hoisted.loadFromDefault
    setCurrentContext = hoisted.setCurrentContext
    makeApiClient = hoisted.makeApiClient
  }
  class PortForward {
    portForward = hoisted.portForward
  }
  class CoreV1Api {}
  class AppsV1Api {}
  return { KubeConfig, PortForward, CoreV1Api, AppsV1Api }
})
vi.mock('../kubernetes/resolve-pod-name', () => ({ resolvePodName: vi.fn() }))

const actualCreateServer = vi.hoisted(() => vi.fn())

vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('net')>()
  actualCreateServer.mockImplementation(actual.createServer as any)
  return { ...actual, createServer: vi.fn() }
})

function fakeServer(server: net.Server): net.Server {
  const s = server as any
  s.listen = (...args: unknown[]) => {
    const cb = args[args.length - 1] as () => void
    queueMicrotask(cb)
    return server
  }
  s.close = (cb?: () => void) => {
    cb?.()
    return server
  }
  return server
}

const { portForward, loadFromFile, loadFromDefault, setCurrentContext, makeApiClient } = hoisted

function makeService(ports: { hostPort: number | null; containerPort: number }[]): WorkItem<KubernetesWorkService> {
  return {
    id: () => 'ks-1',
    name: 'ksvc',
    status: { write: vi.fn(), console: vi.fn() } as any,
    data: {
      type: 'kubernetes-service',
      name: 'ksvc',
      cwd: '',
      description: null,
      kubeconfig: '',
      context: 'ctx',
      namespace: 'ns',
      selector: { type: 'pod', name: 'p' } as any,
      ports,
      labels: {},
      scope: {} as any,
      caching: {} as any,
      src: [],
    },
    needs: [],
    deps: [],
    requiredBy: [],
  } as unknown as WorkItem<KubernetesWorkService>
}

const createdHandlers: ((socket: any) => void)[] = []

function makeOptions(abort: AbortSignal): ExecuteOptions<ServiceState> {
  return {
    state: new State<ServiceState>({ type: 'pending', stateKey: null }),
    stateKey: 'ks',
    abort,
    daemon: false,
    publishPorts: true,
    waitForReady: true,
    cache: { cached: false, stateKey: 'ks', resolved: {} as any, provable: true },
  }
}

describe('kubernetesService', () => {
  beforeEach(() => {
    loadFromFile.mockReset()
    loadFromDefault.mockReset()
    setCurrentContext.mockReset()
    makeApiClient.mockReset().mockReturnValue({})
    portForward.mockReset()
    createdHandlers.length = 0
    vi.mocked(net.createServer)
      .mockReset()
      .mockImplementation(((handler?: (socket: net.Socket) => void) => {
        createdHandlers.push(handler as any)
        const server = actualCreateServer(handler) as net.Server
        return fakeServer(server)
      }) as any)
    vi.mocked(resolvePodName).mockReset().mockResolvedValue('pod-1')
  })

  it('reports an error state when pod resolution fails', async () => {
    vi.mocked(resolvePodName).mockRejectedValue(new Error('no pod'))
    const service = makeService([])
    const options = makeOptions(new AbortController().signal)

    await kubernetesService(service, options)

    expect(options.state.current).toEqual({
      type: 'error',
      stateKey: 'ks',
      errorMessage: 'no pod',
    })
    expect(service.status.write).toHaveBeenCalledWith('error', 'no pod')
    expect(portForward).not.toHaveBeenCalled()
  })

  it('runs without port-forwarding when all ports have null hostPort, ending on an already-aborted signal', async () => {
    const service = makeService([{ hostPort: null, containerPort: 3000 }])
    const abort = new AbortController()
    abort.abort()
    const options = makeOptions(abort.signal)

    await kubernetesService(service, options)

    expect(portForward).not.toHaveBeenCalled()
    expect(options.state.current).toEqual({
      type: 'end',
      reason: 'terminated',
      stateKey: 'ks',
    })
  })

  it('port-forwards ports with a hostPort and ends terminated on abort', async () => {
    portForward.mockResolvedValue({ on: vi.fn() })
    const service = makeService([{ hostPort: 0, containerPort: 3000 }])
    const abort = new AbortController()
    const options = makeOptions(abort.signal)
    const done = kubernetesService(service, options)

    await vi.waitFor(() => {
      expect(options.state.current.type).toBe('running')
    })

    // simulate a socket connection to trigger the actual port-forward
    expect(createdHandlers.length).toBe(1)
    createdHandlers[0]({ destroy: vi.fn(), on: vi.fn() })
    await vi.waitFor(() => {
      expect(portForward).toHaveBeenCalledWith('ns', 'pod-1', [3000], expect.anything(), null, expect.anything(), 0)
    })
    expect(service.status.write).toHaveBeenCalledWith('info', expect.stringContaining('forwarding'))

    abort.abort()
    await done

    expect(options.state.current).toEqual({ type: 'end', reason: 'terminated', stateKey: 'ks' })
  })

  it('destroys the socket when portForward rejects and still reaches running', async () => {
    const fakeSocket = { destroy: vi.fn(), on: vi.fn() } as any
    let connectionHandler: ((socket: any) => void) | undefined
    vi.mocked(net.createServer).mockImplementationOnce(((
      handler?: ((socket: net.Socket) => void) | import('net').ServerOpts
    ) => {
      connectionHandler = handler as any
      const server = actualCreateServer(handler) as net.Server
      return fakeServer(server)
    }) as any)

    try {
      portForward.mockRejectedValue(new Error('forward refused'))
      const service = makeService([{ hostPort: 0, containerPort: 3000 }])
      const abort = new AbortController()
      const options = makeOptions(abort.signal)
      const done = kubernetesService(service, options)

      await vi.waitFor(() => {
        expect(options.state.current.type).toBe('running')
      })
      expect(connectionHandler).toBeDefined()
      connectionHandler!(fakeSocket)
      await Promise.resolve()
      await Promise.resolve()
      expect(fakeSocket.destroy).toHaveBeenCalled()

      abort.abort()
      await done

      expect(options.state.current).toEqual({ type: 'end', reason: 'terminated', stateKey: 'ks' })
      expect(service.status.write).toHaveBeenCalledWith('error', expect.stringContaining('port-forward failed'))
    } finally {
      vi.mocked(net.createServer).mockReset()
    }
  })

  it('reports an error and closes previous servers when listen fails', async () => {
    const { createServer: realCreateServer } = await vi.importActual<typeof import('net')>('net')
    const occupied = realCreateServer()
    await new Promise<void>((resolve) => occupied.listen(45987, '127.0.0.1', resolve))
    const firstServer = { close: vi.fn((cb?: () => void) => cb?.()) }
    vi.mocked(net.createServer).mockReset()
    vi.mocked(net.createServer)
      .mockImplementationOnce(((handler?: (socket: net.Socket) => void) => {
        const server = actualCreateServer(handler) as net.Server
        ;(server as any).listen = (...args: unknown[]) => {
          const cb = args[args.length - 1] as () => void
          queueMicrotask(cb)
          return server
        }
        ;(server as any).close = (cb?: () => void) => {
          cb?.()
          firstServer.close(cb)
          return server
        }
        return server
      }) as any)
      // second server listens for real on the occupied port -> EADDRINUSE
      .mockImplementationOnce(((handler?: (socket: net.Socket) => void) => realCreateServer(handler)) as any)
    try {
      portForward.mockResolvedValue({ on: vi.fn() })
      const service = makeService([
        { hostPort: 0, containerPort: 3000 },
        { hostPort: 45987, containerPort: 3001 },
      ])
      const abort = new AbortController()
      const options = makeOptions(abort.signal)

      await kubernetesService(service, options)

      expect(options.state.current.type).toBe('error')
      if (options.state.current.type === 'error') {
        expect(options.state.current.errorMessage).toContain('EADDRINUSE')
      }
      expect(service.status.write).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('failed to start port-forward')
      )
      expect(firstServer.close).toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
  })
})
