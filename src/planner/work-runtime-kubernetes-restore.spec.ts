import { kubernetesTaskRuntime } from './work-runtime-kubernetes'
import { getStateDirsInUse } from '../kubernetes/ensure-persistent-data'
import { restoreKubernetesData } from '../kubernetes/restore-kubernetes-data'
import { getStateFilesDir } from '../kubernetes/volumes'
import { forgetClaimState, recordClaimState, rememberedClaimState } from '../kubernetes/kept-claims'

const jobs: { items: any[] } = { items: [] }
vi.mock('../kubernetes/kubernetes-instance', () => ({
  createKubernetesInstances: () => ({
    batchApi: { listNamespacedJob: async () => jobs },
    coreApi: { readNamespacedPersistentVolumeClaim: async () => ({ metadata: {} }) },
  }),
}))
vi.mock('../kubernetes/ensure-persistent-data', async (original) => ({
  ...(await original<object>()),
  getStateDirsInUse: vi.fn(),
}))
vi.mock('../kubernetes/restore-kubernetes-data', () => ({ restoreKubernetesData: vi.fn() }))
vi.mock('../kubernetes/kept-claims', async (original) => ({
  ...(await original<object>()),
  forgetClaimState: vi.fn(),
  recordClaimState: vi.fn(),
  rememberedClaimState: vi.fn(),
}))

// What a step did to the claim of the task, in order
function claimSteps(): string[] {
  const steps = [
    ...vi.mocked(forgetClaimState).mock.calls.map((call, i) => ({
      order: vi.mocked(forgetClaimState).mock.invocationCallOrder[i],
      text: `forget ${call[2]}`,
    })),
    ...vi.mocked(recordClaimState).mock.calls.map((call, i) => ({
      order: vi.mocked(recordClaimState).mock.invocationCallOrder[i],
      text: `record ${call[2]} ${call[3]}`,
    })),
    ...vi.mocked(restoreKubernetesData).mock.calls.map((call, i) => ({
      order: vi.mocked(restoreKubernetesData).mock.invocationCallOrder[i],
      text: `restore ${call[5]?.stateKey}`,
    })),
  ]
  return steps.sort((a, b) => a.order - b.order).map((step) => step.text)
}

const env = { type: 'kubernetes', namespace: 'hk-run', server: { run: 'run_1', serviceRun: true } } as any
const status = { write: vi.fn() }
const task = {
  id: () => 'build',
  name: 'build',
  status,
  data: { type: 'container-task', name: 'build', cwd: '/repo', generates: [{ path: '/repo/dist' }] },
} as any
const claim = 'hammerkit-build-' // getClaimName of a claim of the run starts so

beforeEach(() => {
  vi.mocked(forgetClaimState).mockReset().mockResolvedValue(true)
  vi.mocked(recordClaimState).mockReset().mockResolvedValue(undefined)
  vi.mocked(rememberedClaimState).mockReset().mockResolvedValue(null)
  vi.mocked(restoreKubernetesData).mockReset().mockResolvedValue(undefined)
  jobs.items = []
})

// A move whose dep did not change restores its cache hit into the folder of the same state,
// which the pods of the services that stay up read.
describe('the restore of a task of a service run', () => {
  it('leaves the outputs of a state that pods of the run mount', async () => {
    vi.mocked(getStateDirsInUse).mockResolvedValue(new Set([getStateFilesDir('key-1')]))
    await kubernetesTaskRuntime(task, env).restore({} as any, '/cache', 'key-1')
    expect(restoreKubernetesData).not.toHaveBeenCalled()
    expect(status.write).toHaveBeenCalledWith(
      'info',
      'build: services of the run use its outputs of this state, they stay'
    )
    // they are whole: the pods mount them only after the task completed
    expect(claimSteps()).toEqual([expect.stringMatching(new RegExp(`^record ${claim}\\S+ key-1$`))])
  })

  it('restores the outputs of a state no pod mounts into its folder, and names the state once they are whole', async () => {
    vi.mocked(getStateDirsInUse).mockResolvedValue(new Set([getStateFilesDir('key-1')]))
    await kubernetesTaskRuntime(task, env).restore({} as any, '/cache', 'key-2')
    expect(restoreKubernetesData).toHaveBeenCalledWith(task, env, expect.anything(), {}, '/cache', {
      stateKey: 'key-2',
    })
    expect(claimSteps().map((step) => step.replace(/hammerkit-\S+/, 'claim'))).toEqual([
      'forget claim',
      'restore key-2',
      'record claim key-2',
    ])
  })

  it('names no state when the restore did not go through', async () => {
    vi.mocked(getStateDirsInUse).mockResolvedValue(new Set())
    vi.mocked(restoreKubernetesData).mockRejectedValue(new Error('upload failed'))
    await expect(kubernetesTaskRuntime(task, env).restore({} as any, '/cache', 'key-2')).rejects.toThrow(
      'upload failed'
    )
    expect(claimSteps().map((step) => step.replace(/hammerkit-\S+/, 'claim'))).toEqual([
      'forget claim',
      'restore key-2',
    ])
  })
})

// A wake: sleep removed the Jobs of the run, its claims stayed with the outputs in them
describe('the state of a task of a service run', () => {
  it('is the one its claim names, without a Job', async () => {
    vi.mocked(rememberedClaimState).mockResolvedValue('key-1')
    expect(await kubernetesTaskRuntime(task, env).currentStateKey({} as any)).toBe('key-1')
  })

  it('is the one of its last Job while the claim names none', async () => {
    jobs.items = [{ status: { succeeded: 1 }, metadata: { labels: { 'hammerkit.dev/state': 'key-0' } } }]
    expect(await kubernetesTaskRuntime(task, env).currentStateKey({} as any)).toBe('key-0')
    jobs.items = []
    expect(await kubernetesTaskRuntime(task, env).currentStateKey({} as any)).toBeNull()
  })

  it('is not read from the claim outside a service run', async () => {
    const run = { ...env, server: { run: 'run_1' } }
    expect(await kubernetesTaskRuntime(task, run).currentStateKey({} as any)).toBeNull()
    expect(rememberedClaimState).not.toHaveBeenCalled()
  })
})
