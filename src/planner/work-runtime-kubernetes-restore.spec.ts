import { kubernetesTaskRuntime } from './work-runtime-kubernetes'
import { ensurePersistentData, getStateDirsInUse } from '../kubernetes/ensure-persistent-data'
import { apply } from '../kubernetes/apply'
import { ensureKubernetesItemNetwork } from '../kubernetes/network-policy'
import { restoreKubernetesData } from '../kubernetes/restore-kubernetes-data'
import { getStateFilesDir } from '../kubernetes/volumes'
import { forgetClaimState, recordClaimState, rememberedClaimState } from '../kubernetes/kept-claims'
import { awaitJobCompletion } from '../kubernetes/await-running-state'
import { QUOTA_TIMEOUT } from '../kubernetes/quota-wait'

const jobs: { items: any[] } = { items: [] }
vi.mock('../kubernetes/kubernetes-instance', () => ({
  createKubernetesInstances: () => ({
    batchApi: { listNamespacedJob: async () => jobs },
    coreApi: {
      readNamespacedPersistentVolumeClaim: async () => ({ metadata: {} }),
      listNamespacedPod: async () => ({ items: [] }),
    },
  }),
}))
vi.mock('../kubernetes/ensure-persistent-data', async (original) => ({
  ...(await original<object>()),
  getStateDirsInUse: vi.fn(),
  ensurePersistentData: vi.fn(),
}))
// what a Job needs on the way, which these tests don't look at
vi.mock('../kubernetes/ensure-namespace', () => ({ ensureNamespace: vi.fn(async () => undefined) }))
vi.mock('../kubernetes/await-running-state', async (original) => ({
  ...(await original<object>()),
  deleteJob: vi.fn(async () => undefined),
  awaitJobCompletion: vi.fn(async () => undefined),
}))
vi.mock('../kubernetes/apply', async (original) => ({ ...(await original<object>()), apply: vi.fn() }))
vi.mock('../kubernetes/secrets', async (original) => ({
  ...(await original<object>()),
  ensureKubernetesSecret: vi.fn(async () => undefined),
  removeKubernetesSecret: vi.fn(async () => undefined),
}))
vi.mock('../kubernetes/job-secrets', async (original) => ({
  ...(await original<object>()),
  ensureJobCredentials: vi.fn(async () => undefined),
  removeJobCredentials: vi.fn(async () => undefined),
}))
vi.mock('../kubernetes/network-policy', async (original) => ({
  ...(await original<object>()),
  ensureKubernetesItemNetwork: vi.fn(),
  releaseKubernetesItemNetwork: vi.fn(async () => undefined),
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
    ...vi.mocked(ensurePersistentData).mock.calls.map((call, i) => ({
      order: vi.mocked(ensurePersistentData).mock.invocationCallOrder[i],
      text: `upload ${call[5]?.files?.dir}`,
    })),
    ...vi.mocked(apply).mock.calls.map((call, i) => ({
      order: vi.mocked(apply).mock.invocationCallOrder[i],
      text: `job ${(call[1] as any).metadata.labels['hammerkit.dev/state']}`,
    })),
  ]
  return steps.sort((a, b) => a.order - b.order).map((step) => step.text)
}

const env = {
  type: 'kubernetes',
  namespace: 'hk-run',
  server: {
    run: 'run_1',
    serviceRun: true,
    pools: [{ name: 'default', platform: { os: 'linux', arch: 'amd64' }, tolerations: [] }],
  },
} as any
const status = { write: vi.fn() }
const task = {
  id: () => 'build',
  name: 'build',
  status,
  data: {
    type: 'container-task',
    name: 'build',
    cwd: '/repo',
    image: 'alpine',
    shell: 'sh',
    cmds: [{ cmd: 'make', path: '/repo' }],
    envs: { variables: {}, replacements: [] },
    capAdd: [],
    secrets: [],
    mounts: [],
    src: [],
    generates: [{ path: '/repo/dist' }],
    network: { type: 'none' },
  },
} as any
const claim = 'hammerkit-build-' // getClaimName of a claim of the run starts so

beforeEach(() => {
  vi.mocked(forgetClaimState).mockReset().mockResolvedValue(true)
  vi.mocked(recordClaimState).mockReset().mockResolvedValue(undefined)
  vi.mocked(rememberedClaimState).mockReset().mockResolvedValue(null)
  vi.mocked(restoreKubernetesData).mockReset().mockResolvedValue(undefined)
  vi.mocked(ensurePersistentData).mockReset().mockResolvedValue(undefined)
  vi.mocked(apply)
    .mockReset()
    .mockResolvedValue({ status: { succeeded: 1 } } as any)
  vi.mocked(ensureKubernetesItemNetwork).mockResolvedValue({
    env: [],
    secretEnv: [],
    hostAliases: [],
    initContainers: [],
    close: () => undefined,
  })
  vi.mocked(getStateDirsInUse).mockReset().mockResolvedValue(new Set())
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
      otherStates: new Set([getStateFilesDir('key-1')]),
    })
    expect(claimSteps().map((step) => step.replace(/hammerkit-\S+/, 'claim'))).toEqual([
      'forget claim',
      'restore key-2',
      'record claim key-2',
    ])
  })

  it('removes the folders of other states no pod mounts, as before a Job', async () => {
    const inUse = new Set([getStateFilesDir('key-1')])
    vi.mocked(getStateDirsInUse).mockResolvedValue(inUse)
    await kubernetesTaskRuntime(task, env).restore({} as any, '/cache', 'key-2')
    expect(vi.mocked(restoreKubernetesData).mock.calls[0][5]).toEqual({ stateKey: 'key-2', otherStates: inUse })
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

  // a claim that names none is being written, or was and that failed: the folder of the
  // state of an earlier Job may be gone
  it('is none while the claim names none, whatever Jobs say', async () => {
    jobs.items = [{ status: { succeeded: 1 }, metadata: { labels: { 'hammerkit.dev/state': 'key-0' } } }]
    expect(await kubernetesTaskRuntime(task, env).currentStateKey({} as any)).toBeNull()
  })

  it('is the one of its last Job when it has no claim', async () => {
    vi.mocked(rememberedClaimState).mockResolvedValue(undefined)
    jobs.items = [{ status: { succeeded: 1 }, metadata: { labels: { 'hammerkit.dev/state': 'key-0' } } }]
    const outputless = { ...task, data: { ...task.data, generates: [] } }
    expect(await kubernetesTaskRuntime(outputless, env).currentStateKey({} as any)).toBe('key-0')
  })

  it('is not read from the claim outside a service run', async () => {
    const run = { ...env, server: { run: 'run_1' } }
    expect(await kubernetesTaskRuntime(task, run).currentStateKey({} as any)).toBeNull()
    expect(rememberedClaimState).not.toHaveBeenCalled()
  })
})

// The first up of a preview whose dep was a miss: the Job writes the folder of its state
describe('the Job of a task of a service run', () => {
  const run = (key: string) => {
    const state = { set: vi.fn(), current: { type: 'running' } }
    return kubernetesTaskRuntime(task, env)
      .execute(
        { hosted: undefined } as any,
        {
          stateKey: key,
          state: state as any,
          abort: new AbortController().signal,
        } as any
      )
      .then(() => state)
  }
  const steps = () => claimSteps().map((step) => step.replace(/^(forget|record) hammerkit-\S+/, '$1 claim'))

  it('names the state once the Job went through, never while the folder is written', async () => {
    const state = await run('key-2')
    expect(steps()).toEqual(['forget claim', `upload ${getStateFilesDir('key-2')}`, 'job key-2', 'record claim key-2'])
    expect(state.set).not.toHaveBeenCalled()
  })

  it('names no state when the Job failed', async () => {
    vi.mocked(apply).mockRejectedValue(new Error('the cluster said no'))
    const state = await run('key-2')
    expect(steps()).toEqual(['forget claim', `upload ${getStateFilesDir('key-2')}`, 'job key-2'])
    expect(state.set).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
  })

  it('names no state when its files could not be uploaded', async () => {
    vi.mocked(ensurePersistentData).mockRejectedValue(new Error('upload failed'))
    await run('key-2')
    expect(steps()).toEqual(['forget claim', `upload ${getStateFilesDir('key-2')}`])
  })

  it('waits for its Job under the rule of the quota, and says why in the log of the task', async () => {
    vi.mocked(apply).mockResolvedValue({ status: {} } as any)
    await run('key-2')
    const quota = vi.mocked(awaitJobCompletion).mock.calls[0][5]
    expect(quota?.timeout).toBe(QUOTA_TIMEOUT)
    quota?.onWaiting?.('waits for room under the quota of the namespace: exceeded quota: hammerkit')
    expect(status.write).toHaveBeenCalledWith(
      'warn',
      'build waits for room under the quota of the namespace: exceeded quota: hammerkit'
    )
  })

  it('runs no Job for a state pods of the run mount, and names it', async () => {
    vi.mocked(getStateDirsInUse).mockResolvedValue(new Set([getStateFilesDir('key-1')]))
    await run('key-1')
    expect(steps()).toEqual(['record claim key-1'])
  })
})
