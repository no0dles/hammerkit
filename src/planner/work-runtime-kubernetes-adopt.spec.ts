import { kubernetesServiceRuntime, kubernetesTaskRuntime } from './work-runtime-kubernetes'
import { DEFINITION_LABEL, ensureKubernetesDeploymentExists } from '../kubernetes/ensure-kubernetes-deployment-exists'
import { ensurePersistentData } from '../kubernetes/ensure-persistent-data'
import { apply } from '../kubernetes/apply'
import { ensureKubernetesItemNetwork, RUN_LABEL } from '../kubernetes/network-policy'
import { awaitJobCompletion, deleteJobAndWait, stopJob } from '../kubernetes/await-running-state'
import { followPodLogs } from '../kubernetes/follow-pod-logs'
import { getRunLabelValue } from '../kubernetes/job-placement'
import { getResourceName } from '../kubernetes/resources'
import { AbortError } from '../executer/abort'
import { ensureKubernetesSecret, removeKubernetesSecret } from '../kubernetes/secrets'
import { ensureJobCredentials, removeJobCredentials } from '../kubernetes/job-secrets'
import { getVolumeName } from '../kubernetes/volumes'
import { STATE_ANNOTATION, WRITER_ANNOTATION } from '../kubernetes/kept-claims'

// the Jobs, Deployments and Secrets of the cluster by name, the pods of each Job by its name,
// and the annotations of the claims
const cluster: {
  jobs: Record<string, any>
  pods: Record<string, any[]>
  deployments: Record<string, any>
  secrets: Set<string>
  claims: Record<string, Record<string, string>>
} = { jobs: {}, pods: {}, deployments: {}, secrets: new Set(), claims: {} }
const notFound = () => Object.assign(new Error('not found'), { code: 404 })
vi.mock('../kubernetes/kubernetes-instance', () => ({
  createKubernetesInstances: () => ({
    appsApi: {
      readNamespacedDeployment: async ({ name }: { name: string }) => {
        if (!cluster.deployments[name]) {
          throw Object.assign(new Error('not found'), { code: 404 })
        }
        return cluster.deployments[name]
      },
    },
    batchApi: {
      listNamespacedJob: async () => ({ items: Object.values(cluster.jobs) }),
      readNamespacedJob: async ({ name }: { name: string }) => {
        if (!cluster.jobs[name]) {
          throw Object.assign(new Error('not found'), { code: 404 })
        }
        return cluster.jobs[name]
      },
    },
    objectApi: {
      patch: async (spec: any) => {
        const annotations = (cluster.claims[spec.metadata.name] ??= {})
        for (const [key, value] of Object.entries(spec.metadata.annotations ?? {})) {
          if (value === null) {
            delete annotations[key]
          } else {
            annotations[key] = value as string
          }
        }
        return spec
      },
    },
    coreApi: {
      readNamespacedSecret: async ({ name }: { name: string }) => {
        if (!cluster.secrets.has(name)) {
          throw notFound()
        }
        return { metadata: { name } }
      },
      readNamespacedPersistentVolumeClaim: async ({ name }: { name: string }) => {
        if (!cluster.claims[name]) {
          throw notFound()
        }
        return { metadata: { name, annotations: cluster.claims[name] } }
      },
      listNamespacedPod: async ({ labelSelector }: { labelSelector: string }) => ({
        items: cluster.pods[labelSelector.replace(/^job-name=/, '')] ?? [],
      }),
    },
  }),
}))
vi.mock('../kubernetes/ensure-persistent-data', async (original) => ({
  ...(await original<object>()),
  getStateDirsInUse: vi.fn(async () => new Set()),
  ensurePersistentData: vi.fn(async () => undefined),
}))
vi.mock('../kubernetes/ensure-namespace', () => ({ ensureNamespace: vi.fn(async () => undefined) }))
vi.mock('../kubernetes/await-running-state', async (original) => ({
  ...(await original<object>()),
  deleteJob: vi.fn(async () => undefined),
  deleteJobAndWait: vi.fn(async () => undefined),
  stopJob: vi.fn(async () => undefined),
  awaitJobCompletion: vi.fn(async () => undefined),
}))
vi.mock('../kubernetes/apply', async (original) => ({ ...(await original<object>()), apply: vi.fn() }))
vi.mock('../kubernetes/follow-pod-logs', () => ({ followPodLogs: vi.fn() }))
vi.mock('../kubernetes/ensure-kubernetes-service-exists', () => ({
  ensureKubernetesServiceExists: vi.fn(async () => undefined),
}))
vi.mock('./service-definition', () => ({ getServiceDefinitionHash: () => 'def' }))
vi.mock('../kubernetes/ensure-kubernetes-deployment-exists', async (original) => ({
  ...(await original<object>()),
  ensureKubernetesDeploymentExists: vi.fn(async () => undefined),
}))
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

const pools = [{ name: 'default', platform: { os: 'linux', arch: 'amd64' }, tolerations: [] }]
const fresh = { type: 'kubernetes', namespace: 'hk-run', httpRoutes: [], server: { run: 'run_1', pools } } as any
const resumed = { ...fresh, server: { ...fresh.server, resumed: { logs: {} } } } as any
const status = { write: vi.fn(), console: vi.fn() }
const task = {
  id: () => 'build',
  name: 'build',
  status,
  needs: [],
  data: {
    type: 'container-task',
    name: 'build',
    cwd: '/repo',
    image: 'alpine',
    shell: 'sh',
    cmds: [
      { cmd: 'make', cwd: '/repo' },
      { cmd: 'make install', cwd: '/repo' },
    ],
    envs: { variables: {}, replacements: [] },
    capAdd: [],
    secrets: [],
    mounts: [],
    src: [],
    generates: [],
    network: { type: 'open' },
  },
} as any
const jobName = getResourceName(task, fresh, '-job')

// the Job the execution before the restart started for a command of the task: its container
// runs the command through the task's shell, as a Job of the task does
function leftJob(
  options: {
    command?: number
    state?: string
    run?: string
    status?: any
    container?: object
    secrets?: string[]
    deleting?: boolean
  } = {}
) {
  const command = options.command ?? 1
  cluster.jobs[jobName] = {
    metadata: {
      name: jobName,
      uid: 'uid-1',
      labels: {
        [RUN_LABEL]: options.run ?? getRunLabelValue('run_1'),
        'hammerkit.dev/state': options.state ?? 'key-1',
      },
      ...(options.deleting ? { deletionTimestamp: new Date() } : {}),
    },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: `cmd-${command}`,
              image: 'alpine',
              command: ['sh', '-c'],
              args: [['make', 'make install', 'make clean'][command - 1]],
              ...options.container,
            },
          ],
          volumes: (options.secrets ?? []).map((secretName) => ({ name: secretName, secret: { secretName } })),
        },
      },
    },
    status: options.status ?? { active: 1 },
  }
}

function execute(env: any, abort = new AbortController().signal) {
  const state = { set: vi.fn(), current: { type: 'running' } }
  return kubernetesTaskRuntime(task, env)
    .execute(
      { hosted: undefined, abortCtrl: new AbortController() } as any,
      {
        stateKey: 'key-1',
        state: state as any,
        abort,
      } as any
    )
    .then(() => state)
}

// the commands a Job was applied for, in order
const applied = () => vi.mocked(apply).mock.calls.map((call) => (call[1] as any).spec.template.spec.containers[0].name)

beforeEach(() => {
  cluster.jobs = {}
  cluster.pods = {}
  cluster.deployments = {}
  cluster.secrets = new Set()
  cluster.claims = {}
  vi.mocked(ensureKubernetesSecret).mockClear()
  vi.mocked(removeKubernetesSecret).mockClear()
  vi.mocked(ensureJobCredentials).mockClear()
  vi.mocked(removeJobCredentials).mockClear()
  vi.mocked(ensureKubernetesDeploymentExists).mockClear()
  vi.mocked(apply)
    .mockReset()
    .mockImplementation(async (_instance, spec: any) => ({ ...spec, status: { succeeded: 1 } }))
  vi.mocked(ensurePersistentData).mockClear()
  vi.mocked(deleteJobAndWait).mockClear()
  vi.mocked(stopJob).mockClear()
  vi.mocked(awaitJobCompletion).mockReset().mockResolvedValue(undefined)
  vi.mocked(followPodLogs)
    .mockReset()
    .mockReturnValue({ settle: async () => undefined, stop: () => undefined })
  vi.mocked(ensureKubernetesItemNetwork).mockResolvedValue({
    env: [],
    secretEnv: [],
    hostAliases: [],
    initContainers: [],
    close: () => undefined,
  })
  status.write.mockClear()
  status.console.mockClear()
})

describe('a task of a run that resumed after a restart', () => {
  it('takes over the Job it left for its state and follows it to its end, then runs the next command', async () => {
    leftJob({ command: 1 })
    const state = await execute(resumed)
    // no upload over the files the Job works on, and the Job stays
    expect(ensurePersistentData).not.toHaveBeenCalled()
    expect(deleteJobAndWait).toHaveBeenCalledTimes(1)
    expect(vi.mocked(awaitJobCompletion).mock.calls[0][2]).toBe(jobName)
    // only the second command gets a Job of its own
    expect(applied()).toEqual(['cmd-2'])
    expect(state.set).not.toHaveBeenCalled()
  })

  it('takes over a Job of its last command that succeeded, and runs no command again', async () => {
    leftJob({ command: 2, status: { succeeded: 1 } })
    const state = await execute(resumed)
    expect(applied()).toEqual([])
    // the finished Job stays for its state label, which currentStateKey reads
    expect(deleteJobAndWait).not.toHaveBeenCalled()
    expect(state.set).not.toHaveBeenCalled()
  })

  it('takes the result of a Job that failed while the server was down', async () => {
    leftJob({ command: 1, status: { failed: 1 } })
    cluster.pods[jobName] = [
      { metadata: {}, status: { containerStatuses: [{ name: 'cmd-1', state: { terminated: { exitCode: 2 } } }] } },
    ]
    vi.mocked(awaitJobCompletion).mockRejectedValue(new Error(`job ${jobName} failed: BackoffLimitExceeded`))
    const state = await execute(resumed)
    expect(applied()).toEqual([])
    expect(state.set).toHaveBeenCalledWith({ stateKey: 'key-1', type: 'crash', exitCode: 2 })
  })

  it('reads the log of the Job it took over on from where the log of the run got to', async () => {
    leftJob({ command: 2 })
    const from = { container: 'containerd://abc', at: '2026-11-22T10:00:00.120000000', count: 2 }
    await execute({ ...resumed, server: { ...resumed.server, resumed: { logs: { build: [from] } } } })
    expect(vi.mocked(followPodLogs).mock.calls[0][5]).toEqual(expect.objectContaining({ from: [from] }))
    // and hands on where it gets to with each line
    const onLine = vi.mocked(followPodLogs).mock.calls[0][4]
    onLine('hello', { ...from, count: 3 })
    expect(status.console).toHaveBeenCalledWith('stdout', 'hello', { ...from, count: 3 })
  })

  it('stops the Job it took over when the run is cancelled, and removes its secrets', async () => {
    leftJob({ command: 1 })
    vi.mocked(awaitJobCompletion).mockRejectedValue(new AbortError())
    const state = await execute(resumed)
    expect(stopJob).toHaveBeenCalledWith(expect.anything(), resumed, jobName)
    expect(state.set).toHaveBeenCalledWith({ stateKey: 'key-1', type: 'canceled' })
    expect(applied()).toEqual([])
    expect(removeKubernetesSecret).toHaveBeenCalled()
    expect(removeJobCredentials).toHaveBeenCalled()
  })

  it('makes no new credentials nor values for the Job it took over, and removes them once it ended', async () => {
    leftJob({ command: 2, secrets: ['build-credentials'] })
    cluster.secrets.add('build-credentials')
    await execute(resumed)
    // the token of the running pod is not replaced
    expect(ensureJobCredentials).not.toHaveBeenCalled()
    expect(ensureKubernetesSecret).not.toHaveBeenCalled()
    expect(removeJobCredentials).toHaveBeenCalled()
    expect(removeKubernetesSecret).toHaveBeenCalled()
  })

  it('makes credentials for the command after the Job it took over, and deletes that Job before', async () => {
    leftJob({ command: 1 })
    await execute(resumed)
    expect(ensureJobCredentials).toHaveBeenCalledTimes(1)
    const deleted = vi.mocked(deleteJobAndWait).mock.invocationCallOrder[0]
    expect(vi.mocked(deleteJobAndWait).mock.calls[0][2]).toBe(jobName)
    expect(deleted).toBeLessThan(vi.mocked(ensureJobCredentials).mock.invocationCallOrder[0])
    expect(deleted).toBeLessThan(vi.mocked(apply).mock.invocationCallOrder[0])
  })

  it('removes the secrets of a Job it took over that failed', async () => {
    leftJob({ command: 1, status: { failed: 1 } })
    vi.mocked(awaitJobCompletion).mockRejectedValue(new Error(`job ${jobName} failed`))
    await execute(resumed)
    expect(removeKubernetesSecret).toHaveBeenCalled()
    expect(removeJobCredentials).toHaveBeenCalled()
  })

  it('starts again when a Secret the Job reads is gone while it runs', async () => {
    leftJob({ command: 2, secrets: ['build-credentials'] })
    await execute(resumed)
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })

  it('takes the result of a Job of its last command that ended, whose Secrets went', async () => {
    leftJob({ command: 2, secrets: ['build-credentials'], status: { succeeded: 1 } })
    await execute(resumed)
    expect(applied()).toEqual([])
  })

  it.each([
    ['another command', { container: { args: ['make all'] } }],
    ['another image', { container: { image: 'alpine:3.19' } }],
    ['a command past its last', { command: 3 }],
    ['no command', { container: { name: 'main' } }],
  ])('starts again when the Job it left runs %s', async (_what, options) => {
    leftJob(options)
    await execute(resumed)
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })

  it('starts again when the Job it left is being deleted', async () => {
    leftJob({ command: 2, deleting: true })
    await execute(resumed)
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })

  it('starts again from its first command when the Job it left is of another state', async () => {
    leftJob({ command: 2, state: 'key-0' })
    await execute(resumed)
    expect(ensurePersistentData).toHaveBeenCalled()
    expect(deleteJobAndWait).toHaveBeenCalledWith(expect.anything(), resumed, jobName, expect.anything())
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })

  it('starts again when the Job of its name is of another run', async () => {
    leftJob({ command: 2, run: getRunLabelValue('run_0') })
    await execute(resumed)
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })

  it('starts again when the Job it left is gone', async () => {
    await execute(resumed)
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })
})

// the claim of a task of a service run, which only the run writes to, or a kept claim, which
// the runs of a source share: its Job says which run and state writes to it
describe('a task with a claim that outlives a Job', () => {
  const serviceRun = { ...fresh, server: { ...fresh.server, serviceRun: true } } as any
  const claim = getVolumeName(task, serviceRun)
  const writer = `${getRunLabelValue('run_1')}/key-1`
  const resumedRun = { ...serviceRun, server: { ...serviceRun.server, resumed: { logs: {} } } } as any

  it('marks the claim as written by the Job of its run and state', async () => {
    cluster.claims[claim] = { [STATE_ANNOTATION]: 'key-0' }
    await execute(serviceRun)
    // the Job succeeded: the claim names its state
    expect(cluster.claims[claim]).toEqual({ [STATE_ANNOTATION]: 'key-1' })
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })

  it('takes over its Job when no other run wrote to the claim since', async () => {
    cluster.claims[claim] = { [WRITER_ANNOTATION]: writer }
    leftJob({ command: 2 })
    await execute(resumedRun)
    expect(applied()).toEqual([])
    expect(cluster.claims[claim]).toEqual({ [STATE_ANNOTATION]: 'key-1' })
  })

  it.each([
    ['another run wrote to it', { [WRITER_ANNOTATION]: `${getRunLabelValue('run_0')}/key-1` }],
    ['it names the state of another run', { [STATE_ANNOTATION]: 'key-0' }],
    ['it was written before writers were marked', {}],
  ])('starts again when %s', async (_why, annotations) => {
    cluster.claims[claim] = annotations
    leftJob({ command: 2 })
    await execute(resumedRun)
    expect(ensurePersistentData).toHaveBeenCalled()
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })
})

describe('the state of a task with several commands', () => {
  it('is not the one of a Job of an earlier command that succeeded', async () => {
    leftJob({ command: 1, status: { succeeded: 1 } })
    expect(await kubernetesTaskRuntime(task, resumed).currentStateKey({} as any)).toBeNull()
  })

  it('is the one of the Job of its last command', async () => {
    leftJob({ command: 2, status: { succeeded: 1 } })
    expect(await kubernetesTaskRuntime(task, resumed).currentStateKey({} as any)).toBe('key-1')
  })
})

describe('a task of a run that did not resume', () => {
  it('deletes a Job of its name and state and starts from its first command', async () => {
    leftJob({ command: 2 })
    await execute(fresh)
    expect(ensurePersistentData).toHaveBeenCalled()
    expect(deleteJobAndWait).toHaveBeenCalledWith(expect.anything(), fresh, jobName, expect.anything())
    expect(applied()).toEqual(['cmd-1', 'cmd-2'])
  })
})

describe('a service of a service run that resumed after a restart', () => {
  const service = {
    id: () => 'web',
    name: 'web',
    status,
    needs: [],
    deps: [],
    data: {
      type: 'container-service',
      name: 'web',
      image: 'nginx',
      cwd: '/repo',
      ports: [],
      mounts: [],
      volumes: [],
      src: [],
      generates: [],
      secrets: [],
      envs: { variables: {}, replacements: [] },
      network: { type: 'open' },
    },
  } as any
  const serviceRun = { ...resumed, server: { ...resumed.server, serviceRun: true } } as any
  const name = getResourceName(service, serviceRun)
  const rolledOut = (state: string, run = 'run_1') => ({
    metadata: {
      name,
      generation: 1,
      labels: { [DEFINITION_LABEL]: 'def', 'hammerkit.dev/state': state, [RUN_LABEL]: getRunLabelValue(run) },
    },
    status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
  })
  const up = (env: any) => {
    const state = { set: vi.fn(), current: { type: 'starting' } }
    return kubernetesServiceRuntime(service, env)
      .execute(
        { abortCtrl: new AbortController() } as any,
        {
          stateKey: 'key-1',
          state: state as any,
          abort: new AbortController().signal,
        } as any
      )
      .then(() => state)
  }

  it('takes over its Deployment that did not change, and reads its log on from where the run’s log got to', async () => {
    cluster.deployments[name] = rolledOut('key-1')
    const from = { container: 'containerd://web', at: '2026-11-22T10:00:00.000000000', count: 4 }
    const state = await up({ ...serviceRun, server: { ...serviceRun.server, resumed: { logs: { web: [from] } } } })
    // its pod is not restarted: nothing is applied
    expect(ensureKubernetesDeploymentExists).not.toHaveBeenCalled()
    expect(state.set).toHaveBeenCalledWith({
      type: 'running',
      dns: { containerId: name },
      stateKey: 'key-1',
      remote: null,
    })
    expect(vi.mocked(followPodLogs).mock.calls[0][5]).toEqual(expect.objectContaining({ from: [from] }))
    const onLine = vi.mocked(followPodLogs).mock.calls[0][4]
    onLine('GET /', { ...from, count: 5 })
    expect(status.console).toHaveBeenCalledWith('stdout', 'GET /', { ...from, count: 5 })
  })

  it('does not take over a Deployment of another run', async () => {
    cluster.deployments[name] = rolledOut('key-1', 'run_0')
    await up(serviceRun)
    expect(ensureKubernetesDeploymentExists).toHaveBeenCalled()
  })

  it('rolls its Deployment when it changed', async () => {
    cluster.deployments[name] = rolledOut('key-0')
    await up(serviceRun)
    expect(ensureKubernetesDeploymentExists).toHaveBeenCalled()
  })
})
