import { PassThrough } from 'stream'
import { tmpdir } from 'os'
import { join } from 'path'
import { dockerService } from './docker-service'
import { environmentMock } from './environment-mock'
import { State } from './state'
import { ServiceState } from './scheduler/service-state'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ExecuteOptions } from '../runtime/runtime'
import { pull } from '../docker/pull'
import { logStream } from '../docker/stream'
import { removeContainer } from '../docker/remove-container'
import { execCommand } from './execute-docker'
import { checkReadiness } from './check-readiness'

vi.mock('../docker/pull', () => ({ pull: vi.fn() }))
vi.mock('../docker/stream', () => ({ logStream: vi.fn() }))
vi.mock('../docker/remove-container', () => ({ removeContainer: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./execute-docker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./execute-docker')>()
  return { ...actual, execCommand: vi.fn() }
})
vi.mock('./check-readiness', () => ({ checkReadiness: vi.fn() }))

function makeItem(overrides: Partial<ContainerWorkService> = {}): WorkItem<ContainerWorkService> {
  return {
    id: () => 'svc-1',
    name: 'svc',
    status: { write: vi.fn(), console: vi.fn() } as any,
    data: {
      type: 'container-service',
      name: 'svc',
      cwd: tmpdir(),
      description: null,
      image: 'img:1',
      envs: { variables: {}, replacements: [] } as any,
      cmd: null,
      src: [],
      mounts: [],
      volumes: [],
      ports: [],
      healthcheck: null,
      continuous: false,
      caching: {} as any,
      labels: {},
      scope: {} as any,
      ...overrides,
    },
    needs: [],
    deps: [],
    requiredBy: [],
  } as unknown as WorkItem<ContainerWorkService>
}

function makeContainer(waitImpl?: () => Promise<unknown>) {
  return {
    id: 'cid-1',
    attach: vi.fn().mockResolvedValue(new PassThrough()),
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn(waitImpl ?? (() => new Promise<never>(() => {}))),
    remove: vi.fn(),
  } as any
}

function makeDocker(container: unknown) {
  return { createContainer: vi.fn().mockResolvedValue(container) } as any
}

function makeOptions(abort: AbortSignal, daemon = false): ExecuteOptions<ServiceState> {
  return {
    state: new State<ServiceState>({ type: 'pending', stateKey: null }),
    stateKey: 'k1',
    abort,
    daemon,
    cache: { cached: false, stateKey: 'k1', resolved: {} as any },
  }
}

function makeEnvironment() {
  return environmentMock(join(tmpdir(), 'hammerkit-docker-service-spec'))
}

describe('dockerService', () => {
  beforeEach(() => {
    vi.mocked(pull).mockReset().mockResolvedValue(undefined)
    vi.mocked(logStream).mockReset()
    vi.mocked(removeContainer).mockReset().mockResolvedValue(undefined)
    vi.mocked(execCommand).mockReset()
    vi.mocked(checkReadiness).mockReset().mockResolvedValue(true)
  })

  it('runs without healthcheck until the container exits, then removes it', async () => {
    const container = makeContainer(() => Promise.resolve(0))
    const docker = makeDocker(container)
    const item = makeItem({
      ports: [
        { hostPort: null, containerPort: 3000 },
        { hostPort: 8080, containerPort: 8080 },
      ],
    })
    const options = makeOptions(new AbortController().signal)

    await dockerService(docker, item, options, makeEnvironment())

    expect(docker.createContainer).toHaveBeenCalledTimes(1)
    const config = docker.createContainer.mock.calls[0][0]
    expect(config.Image).toBe('img:1')
    expect(config.Labels).toMatchObject({
      app: 'hammerkit',
      'hammerkit-type': 'service',
      'hammerkit-state': 'k1',
    })
    expect(config.ExposedPorts).toEqual({
      '3000/tcp': {},
      '8080/tcp': {},
    })
    expect(config.HostConfig.PortBindings).toEqual({ '8080/tcp': [{ HostPort: '8080' }] })
    expect(config.HostConfig.Binds).toEqual([])

    expect(options.state.current).toEqual({ type: 'end', reason: 'crash', stateKey: 'k1' })
    expect(removeContainer).toHaveBeenCalledWith(container)
    expect(container.wait).toHaveBeenCalled()
  })

  it('leaves the container running in daemon mode', async () => {
    const container = makeContainer()
    const docker = makeDocker(container)
    const item = makeItem()
    const options = makeOptions(new AbortController().signal, true)

    await dockerService(docker, item, options, makeEnvironment())

    expect(options.state.current).toEqual({
      type: 'running',
      dns: { containerId: 'cid-1' },
      stateKey: 'k1',
      remote: null,
    })
    expect(container.wait).not.toHaveBeenCalled()
    expect(removeContainer).not.toHaveBeenCalled()
  })

  it('becomes running when the healthcheck is ready', async () => {
    const container = makeContainer()
    const docker = makeDocker(container)
    const healthcheck = { cmd: 'true', timeout: 1, retries: 1 } as any
    const item = makeItem({ healthcheck })
    const abort = new AbortController()
    const options = makeOptions(abort.signal, true)
    const environment = makeEnvironment()

    await dockerService(docker, item, options, environment)

    expect(checkReadiness).toHaveBeenCalledWith(item.status, healthcheck, environment, container, abort.signal)
    expect(options.state.current).toEqual({
      type: 'running',
      dns: { containerId: 'cid-1' },
      stateKey: 'k1',
      remote: null,
    })
    // never-ready loop exits on abort; abort the controller so wait resolves terminated
    abort.abort()
  })

  it('keeps checking readiness until abort, then ends terminated', async () => {
    vi.mocked(checkReadiness).mockResolvedValue(false)
    const container = makeContainer()
    const docker = makeDocker(container)
    const item = makeItem({ healthcheck: { cmd: 'false', timeout: 1, retries: 1 } as any })
    const abort = new AbortController()
    const options = makeOptions(abort.signal)
    const done = dockerService(docker, item, options, makeEnvironment())
    setTimeout(() => abort.abort(), 50)

    await done

    expect(checkReadiness).toHaveBeenCalled()
    expect(options.state.current).toEqual({ type: 'end', reason: 'terminated', stateKey: 'k1' })
    expect(removeContainer).toHaveBeenCalledWith(container)
  })

  it('ends with crash and skips removal when createContainer rejects', async () => {
    const docker = { createContainer: vi.fn().mockRejectedValue(new Error('no daemon')) } as any
    const item = makeItem()
    const options = makeOptions(new AbortController().signal)

    await dockerService(docker, item, options, makeEnvironment())

    expect(options.state.current).toEqual({ type: 'end', reason: 'crash', stateKey: 'k1' })
    expect(item.status.write).toHaveBeenCalledWith('error', expect.stringContaining('no daemon'))
    expect(removeContainer).not.toHaveBeenCalled()
  })

  it('cancels when the abort signal is already aborted', async () => {
    const container = makeContainer()
    const docker = makeDocker(container)
    const item = makeItem()
    const abort = new AbortController()
    abort.abort()
    const options = makeOptions(abort.signal)

    await dockerService(docker, item, options, makeEnvironment())

    expect(options.state.current).toEqual({ type: 'canceled', stateKey: 'k1' })
    expect(docker.createContainer).not.toHaveBeenCalled()
    expect(removeContainer).not.toHaveBeenCalled()
  })

  it('ends terminated when abort fires while waiting on a healthcheck-less service', async () => {
    const container = makeContainer()
    const docker = makeDocker(container)
    const item = makeItem()
    const abort = new AbortController()
    const options = makeOptions(abort.signal)
    const done = dockerService(docker, item, options, makeEnvironment())
    setTimeout(() => abort.abort(), 20)

    await done

    expect(options.state.current).toEqual({ type: 'end', reason: 'terminated', stateKey: 'k1' })
  })
})
