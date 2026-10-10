import { createHash } from 'crypto'
import { getWorkServiceId } from './work-service-id'
import { ContainerWorkService, KubernetesWorkService, WorkService } from './work-service'
import { WorkSource } from './work-source'
import { WorkMount } from './work-mount'
import { WorkVolume } from './work-volume'
import { WorkKubernetesSelector } from './work-kubernetes-selector'
import { getVolumeName } from './utils/plan-work-volume'

function sha1(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex')
}

function makeSource(absolutePath: string): WorkSource {
  return { absolutePath, source: absolutePath, matcher: () => true, inherited: null, isFile: false }
}

function makeMount(mount: string): WorkMount {
  return { mount, localPath: '/local', containerPath: mount, isFile: false, readOnly: false }
}

function makeVolume(name: string, containerPath: string): WorkVolume {
  return { name, containerPath, resetOnChange: false, inherited: null, export: true, readOnly: false }
}

function makeContainerService(overrides: Partial<ContainerWorkService> = {}): ContainerWorkService {
  return {
    type: 'container-service',
    name: 'api',
    projectRoot: '/repo',
    cwd: '/repo/services/api',
    description: null,
    image: 'node:20',
    envs: { variables: {}, processEnvs: {} } as any,
    cmd: null,
    src: [makeSource('/repo/services/api/src')],
    continuous: false,
    caching: { name: 'none', method: 'none', backend: {} as any, implicit: true },
    mounts: [makeMount('/repo/services/api/node_modules')],
    volumes: [makeVolume('data', '/var/lib/data')],
    healthcheck: null,
    ports: [],
    labels: {},
    scope: {} as any,
    ...overrides,
  } as ContainerWorkService
}

function makeKubernetesService(overrides: Partial<KubernetesWorkService> = {}): KubernetesWorkService {
  const selector: WorkKubernetesSelector = { type: 'service', name: 'api' }
  return {
    type: 'kubernetes-service',
    name: 'api',
    projectRoot: '/repo',
    cwd: '/repo/services/api',
    description: null,
    context: 'prod',
    kubeconfig: '/path/kubeconfig',
    namespace: 'demo',
    selector,
    src: [],
    caching: { name: 'none', method: 'none', backend: {} as any, implicit: true },
    ports: [],
    labels: {},
    scope: {} as any,
    ...overrides,
  } as KubernetesWorkService
}

describe('getWorkServiceId', () => {
  it('hashes the canonical container service shape', () => {
    const service = makeContainerService()

    expect(getWorkServiceId(service)).toBe(
      sha1({
        cwd: 'services/api',
        image: 'node:20',
        volumes: ['data:/var/lib/data'],
        src: ['services/api/src'],
        mounts: ['/repo/services/api/node_modules'],
      })
    )
  })

  it('is insensitive to the order of volumes, src and mounts', () => {
    const a = makeContainerService({
      volumes: [makeVolume('a', '/a'), makeVolume('b', '/b')],
      src: [makeSource('/s1'), makeSource('/s2')],
      mounts: [makeMount('/m1'), makeMount('/m2')],
    })
    const b = makeContainerService({
      volumes: [makeVolume('b', '/b'), makeVolume('a', '/a')],
      src: [makeSource('/s2'), makeSource('/s1')],
      mounts: [makeMount('/m2'), makeMount('/m1')],
    })

    expect(getWorkServiceId(a)).toBe(getWorkServiceId(b))
  })

  it('produces different ids for different container services', () => {
    const a = getWorkServiceId(makeContainerService())
    const b = getWorkServiceId(makeContainerService({ image: 'node:22' }))

    expect(a).not.toBe(b)
  })

  it('hashes the canonical kubernetes service shape', () => {
    const service = makeKubernetesService()

    expect(getWorkServiceId(service)).toBe(
      sha1({
        context: 'prod',
        selector: { type: 'service', name: 'api' },
        kubeconfig: '/path/kubeconfig',
      })
    )
  })

  it('is the same wherever the project is checked out', () => {
    const a = makeContainerService()
    const b = makeContainerService({
      projectRoot: '/checkout',
      cwd: '/checkout/services/api',
      src: [makeSource('/checkout/services/api/src')],
    })

    expect(getWorkServiceId(a)).toBe(getWorkServiceId(b))
  })

  it('hashes only the path of a volume with a derived name', () => {
    const service = makeContainerService({ volumes: [makeVolume(getVolumeName('/repo/data'), '/repo/data')] })

    expect(getWorkServiceId(service)).toBe(
      sha1({
        cwd: 'services/api',
        image: 'node:20',
        volumes: ['data'],
        src: ['services/api/src'],
        mounts: ['/repo/services/api/node_modules'],
      })
    )
  })

  it('includes workdir and shell only when declared', () => {
    const plain = getWorkServiceId(makeContainerService())

    expect(getWorkServiceId(makeContainerService({ workdir: null, shell: null }))).toBe(plain)
    expect(getWorkServiceId(makeContainerService({ workdir: '/app' }))).not.toBe(plain)
    expect(getWorkServiceId(makeContainerService({ shell: 'sh' }))).not.toBe(plain)
  })

  it('produces different ids for different kubernetes services', () => {
    const a = getWorkServiceId(makeKubernetesService())
    const b = getWorkServiceId(makeKubernetesService({ context: 'staging' }))

    expect(a).not.toBe(b)
  })

  it('distinguishes a container service from a kubernetes service', () => {
    const service: WorkService = makeContainerService()
    const kubernetesService: WorkService = makeKubernetesService()

    expect(getWorkServiceId(service)).not.toBe(getWorkServiceId(kubernetesService))
  })
})
