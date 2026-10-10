import { Exec } from '@kubernetes/client-node'
import { createKubernetesInstances } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

const mocks = vi.hoisted(() => {
  return {
    loadFromFile: vi.fn(),
    loadFromDefault: vi.fn(),
    setCurrentContext: vi.fn(),
    makeApiClient: vi.fn(),
  }
})

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromFile = mocks.loadFromFile
    loadFromDefault = mocks.loadFromDefault
    setCurrentContext = mocks.setCurrentContext
    makeApiClient = mocks.makeApiClient
  }
  class Exec {}
  class CoreV1Api {}
  class BatchV1Api {}
  class AppsV1Api {}
  class KubernetesObjectApi {}
  return { KubeConfig, Exec, CoreV1Api, BatchV1Api, AppsV1Api, KubernetesObjectApi }
})

function makeEnv(overrides: Partial<WorkKubernetesEnvironment> = {}): WorkKubernetesEnvironment {
  return { type: 'kubernetes', namespace: 'ns', context: 'ctx', httpRoutes: [], ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.makeApiClient.mockImplementation((cls: unknown) => `client-for-${(cls as { name: string }).name}`)
})

describe('createKubernetesInstances', () => {
  it('loads the kubeConfig from the given file when set', () => {
    createKubernetesInstances(makeEnv({ kubeConfig: '/path/to/kubeconfig' }))

    expect(mocks.loadFromFile).toHaveBeenCalledWith('/path/to/kubeconfig')
    expect(mocks.loadFromDefault).not.toHaveBeenCalled()
  })

  it('falls back to the default kube config when no kubeConfig is set', () => {
    createKubernetesInstances(makeEnv())

    expect(mocks.loadFromDefault).toHaveBeenCalledTimes(1)
    expect(mocks.loadFromFile).not.toHaveBeenCalled()
  })

  it('sets the current context from the environment', () => {
    createKubernetesInstances(makeEnv({ context: 'my-context' }))

    expect(mocks.setCurrentContext).toHaveBeenCalledWith('my-context')
  })

  it('exposes every kubernetes client instance', () => {
    const instance = createKubernetesInstances(makeEnv())

    expect(instance.objectApi).toBe('client-for-KubernetesObjectApi')
    expect(instance.coreApi).toBe('client-for-CoreV1Api')
    expect(instance.batchApi).toBe('client-for-BatchV1Api')
    expect(instance.appsApi).toBe('client-for-AppsV1Api')
    expect(instance.exec).toBeInstanceOf(Exec)
  })

  it('translates "No active cluster!" into a context-specific error mentioning the kubeConfig file', () => {
    mocks.loadFromFile.mockImplementation(() => {
      throw new Error('No active cluster!')
    })

    expect(() => createKubernetesInstances(makeEnv({ kubeConfig: '/path/to/kubeconfig' }))).toThrow(
      'No cluster found for context ctx in /path/to/kubeconfig'
    )
  })

  it('translates "No active cluster!" into a context-specific error without a kubeConfig file', () => {
    mocks.loadFromDefault.mockImplementation(() => {
      throw new Error('No active cluster!')
    })

    expect(() => createKubernetesInstances(makeEnv({ context: 'ctx' }))).toThrow('No cluster found for context ctx')
  })

  it('rethrows unrelated errors unchanged', () => {
    mocks.loadFromDefault.mockImplementation(() => {
      throw new Error('something else')
    })

    expect(() => createKubernetesInstances(makeEnv())).toThrow('something else')
  })
})
