import { ApiException } from '@kubernetes/client-node'
import {
  awaitDeployRollout,
  awaitDeployRunningState,
  awaitJobCompletion,
  awaitRunningState,
  deleteJob,
  deleteJobAndWait,
  stopJob,
  watchKeptPods,
} from './await-running-state'
import { AbortError } from '../executer/abort'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

const env = {
  type: 'kubernetes',
  namespace: 'demo',
  context: 'ctx',
  httpRoutes: [],
  networkPolicyEnforced: false,
} as WorkKubernetesEnvironment

function httpError(code: number): ApiException<undefined> {
  return new ApiException(code, `http ${code}`, undefined, {})
}

describe('awaitRunningState', () => {
  it('polls the pod until it reaches the phase', async () => {
    const readNamespacedPod = vi
      .fn()
      .mockResolvedValueOnce({ status: { phase: 'Pending' } })
      .mockResolvedValueOnce({ status: {} })
      .mockResolvedValueOnce({ status: { phase: 'Running' } })
    const instance = { coreApi: { readNamespacedPod } } as unknown as KubernetesInstance

    await awaitRunningState(instance, env, 'upload', 'Running', 0)

    expect(readNamespacedPod).toHaveBeenCalledTimes(3)
    expect(readNamespacedPod).toHaveBeenCalledWith({ name: 'upload', namespace: 'demo' })
  })

  it('fails once the pod ended without reaching the phase', async () => {
    const readNamespacedPod = vi.fn().mockResolvedValue({ status: { phase: 'Failed' } })
    const instance = { coreApi: { readNamespacedPod } } as unknown as KubernetesInstance

    await expect(awaitRunningState(instance, env, 'upload', 'Running', 0)).rejects.toThrow(
      'pod upload ended in phase Failed before reaching Running'
    )
  })
})

describe('awaitDeployRunningState', () => {
  const noDeadline = { podSelector: 'hammerkit.dev/id=api', timeout: null, timeoutMessage: '' }

  function polling(...pods: object[][]) {
    const readNamespacedDeployment = vi.fn().mockResolvedValue({ status: { availableReplicas: 0 } })
    const listNamespacedPod = vi.fn()
    for (const items of pods) {
      listNamespacedPod.mockResolvedValueOnce({ items })
    }
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod },
    } as unknown as KubernetesInstance
    return { instance, listNamespacedPod }
  }

  const pod = (container: object, extra: object = {}) => ({
    metadata: { name: 'api-1' },
    status: {
      phase: 'Pending',
      containerStatuses: [{ name: 'api', image: 'api:1', restartCount: 0, ...container }],
      ...extra,
    },
  })

  it('fails at once with the reason when the image can not be pulled, without a deadline', async () => {
    const { instance } = polling(
      [pod({ state: { waiting: { reason: 'ContainerCreating' } } })],
      [pod({ state: { waiting: { reason: 'ImagePullBackOff', message: 'pull api:1: not found' } } })]
    )
    await expect(
      awaitDeployRunningState(instance, env, 'api', { ...noDeadline, container: 'api', subject: 'service api' }, 0)
    ).rejects.toThrow(
      'service api can not become ready, its image api:1 could not be pulled (ImagePullBackOff): pull api:1: not found'
    )
  })

  it('fails a reason that may still pass only once it lasted a minute', async () => {
    const limited = pod({ state: { waiting: { reason: 'ImagePullBackOff', message: '429 Too Many Requests' } } })
    const { instance, listNamespacedPod } = polling([limited])
    listNamespacedPod.mockResolvedValue({ items: [limited] })
    let clock = 0
    const said: string[] = []
    const waiting = awaitDeployRunningState(
      instance,
      env,
      'api',
      { ...noDeadline, container: 'api', subject: 'service api', onWaiting: (text) => said.push(text) },
      0,
      () => (clock += 10_000)
    )
    await expect(waiting).rejects.toThrow(
      'service api can not become ready, its image api:1 could not be pulled (ImagePullBackOff): 429 Too Many Requests'
    )
    expect(said).toEqual(['can not pull its image api:1 yet: 429 Too Many Requests'])
    // it waited a minute for it
    expect(listNamespacedPod.mock.calls.length).toBeGreaterThanOrEqual(6)
  })

  it('passes over the pods of a Deployment deleted before this one was created', async () => {
    const crashed = {
      restartCount: 3,
      state: { waiting: { reason: 'CrashLoopBackOff' } },
      lastState: { terminated: { exitCode: 1 } },
    }
    const terminating = {
      ...pod(crashed),
      metadata: { name: 'old-1', deletionTimestamp: new Date(1000), creationTimestamp: new Date(0) },
    }
    // its ReplicaSet not yet removed: no deletion timestamp, but older than the Deployment
    const older = { ...pod(crashed), metadata: { name: 'old-2', creationTimestamp: new Date(0) } }
    const starting = {
      ...pod({ state: { waiting: { reason: 'ContainerCreating' } } }),
      metadata: { name: 'new-1', creationTimestamp: new Date(5000) },
    }
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { creationTimestamp: new Date(4000) }, status: {} })
      .mockResolvedValueOnce({ metadata: { creationTimestamp: new Date(4000) }, status: { availableReplicas: 1 } })
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [terminating, older, starting] })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod },
    } as unknown as KubernetesInstance

    await awaitDeployRunningState(instance, env, 'api', { ...noDeadline, container: 'api' }, 0)
    expect(readNamespacedDeployment).toHaveBeenCalledTimes(2)
  })

  it('fails when the container keeps crashing, with how it ended last', async () => {
    const { instance } = polling([
      pod({
        restartCount: 2,
        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 20s' } },
        lastState: { terminated: { exitCode: 1, reason: 'Error' } },
      }),
    ])
    await expect(
      awaitDeployRunningState(instance, env, 'api', { ...noDeadline, container: 'api', subject: 'service api' }, 0)
    ).rejects.toThrow(
      'service api can not become ready, it keeps crashing: it exited with code 1 (Error), restarted 2 times'
    )
  })

  it('only looks at the container it is told, not at the debug one beside it', async () => {
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ status: { availableReplicas: 0 } })
      .mockResolvedValueOnce({ status: { availableReplicas: 1 } })
    const listNamespacedPod = vi.fn().mockResolvedValue({
      items: [
        {
          status: {
            containerStatuses: [
              { name: 'debug', image: 'x', restartCount: 0, state: { waiting: { reason: 'CrashLoopBackOff' } } },
            ],
          },
        },
      ],
    })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod },
    } as unknown as KubernetesInstance
    await awaitDeployRunningState(instance, env, 'api', { ...noDeadline, container: 'api' }, 0)
    expect(readNamespacedDeployment).toHaveBeenCalledTimes(2)
  })

  it('says what a pod waits for once each time it changes', async () => {
    const unscheduled = {
      metadata: { name: 'api-1' },
      status: {
        phase: 'Pending',
        conditions: [
          { type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available' },
        ],
      },
    }
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ status: {} })
      .mockResolvedValueOnce({ status: {} })
      .mockResolvedValueOnce({ status: {} })
      .mockResolvedValueOnce({ status: { availableReplicas: 1 } })
    const listNamespacedPod = vi
      .fn()
      .mockResolvedValueOnce({ items: [unscheduled] })
      .mockResolvedValueOnce({ items: [unscheduled] })
      .mockResolvedValueOnce({ items: [] })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod },
    } as unknown as KubernetesInstance
    const said: string[] = []
    await awaitDeployRunningState(instance, env, 'api', { ...noDeadline, onWaiting: (text) => said.push(text) }, 0)
    expect(said).toEqual(['waits for a node: 0/3 nodes are available'])
  })

  it('polls the deployment until a replica is ready', async () => {
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ status: {} })
      .mockResolvedValueOnce({ status: { availableReplicas: 0 } })
      .mockResolvedValueOnce({ status: { availableReplicas: 1 } })
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [] })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod },
    } as unknown as KubernetesInstance

    await awaitDeployRunningState(instance, env, 'api', noDeadline, 0)

    expect(readNamespacedDeployment).toHaveBeenCalledTimes(3)
    expect(readNamespacedDeployment).toHaveBeenCalledWith({ name: 'api', namespace: 'demo' })
  })

  it('starts the deadline only once a pod runs and fails when it passes', async () => {
    const readNamespacedDeployment = vi.fn().mockResolvedValue({ status: { availableReplicas: 0 } })
    const listNamespacedPod = vi
      .fn()
      // pulling the image: does not count against the deadline
      .mockResolvedValueOnce({ items: [{ status: { phase: 'Pending' } }] })
      .mockResolvedValueOnce({ items: [{ status: { phase: 'Pending' } }] })
      .mockResolvedValue({ items: [{ status: { phase: 'Running' } }] })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod },
    } as unknown as KubernetesInstance
    let clock = 0
    const now = () => (clock += 10_000)

    await expect(
      awaitDeployRunningState(
        instance,
        env,
        'api',
        { podSelector: 'hammerkit.dev/id=abc', timeout: 20_000, timeoutMessage: 'api not ready' },
        0,
        now
      )
    ).rejects.toThrow('api not ready')

    expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'demo', labelSelector: 'hammerkit.dev/id=abc' })
    // two pending polls, then running at t=10s, failing once 20s passed; the pods are
    // looked at on each poll, for a reason they will not become ready
    expect(listNamespacedPod).toHaveBeenCalledTimes(5)
    expect(readNamespacedDeployment).toHaveBeenCalledTimes(5)
  })

  it('starts the deadline again at each start, so a crash loop is counted by its restarts', async () => {
    const running = (restartCount: number) =>
      pod({ state: { running: {} }, restartCount, lastState: { terminated: { exitCode: 1 } } }, { phase: 'Running' })
    const backingOff = (restartCount: number) =>
      pod(
        {
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          restartCount,
          lastState: { terminated: { exitCode: 1 } },
        },
        { phase: 'Running' }
      )
    const { instance } = polling(
      [running(0)],
      [backingOff(0)],
      [backingOff(0)],
      [running(1)],
      [backingOff(1)],
      [backingOff(1)],
      [running(2)],
      [backingOff(2)],
      [backingOff(2)],
      [running(3)],
      [backingOff(3)]
    )
    let clock = 0
    const now = () => (clock += 15_000)
    await expect(
      awaitDeployRunningState(
        instance,
        env,
        'api',
        { ...noDeadline, timeout: 20_000, timeoutMessage: 'api not ready', container: 'api', restarts: 3 },
        0,
        now
      )
    ).rejects.toThrow('api can not become ready, it keeps crashing: it exited with code 1, restarted 3 times')
  })

  it('fails a container that runs but never becomes ready once the deadline passed', async () => {
    const { instance } = polling(
      ...Array.from({ length: 5 }, () => [pod({ state: { running: {} } }, { phase: 'Running' })])
    )
    let clock = 0
    const now = () => (clock += 10_000)
    await expect(
      awaitDeployRunningState(
        instance,
        env,
        'api',
        { ...noDeadline, timeout: 20_000, timeoutMessage: 'api not ready', container: 'api' },
        0,
        now
      )
    ).rejects.toThrow('api not ready')
  })

  it('returns when a replica becomes ready within the deadline', async () => {
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ status: { availableReplicas: 0 } })
      .mockResolvedValueOnce({ status: { availableReplicas: 1 } })
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [{ status: { phase: 'Running' } }] })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod },
    } as unknown as KubernetesInstance

    await awaitDeployRunningState(
      instance,
      env,
      'api',
      { podSelector: 'hammerkit.dev/id=abc', timeout: 20_000, timeoutMessage: 'api not ready' },
      0
    )

    expect(readNamespacedDeployment).toHaveBeenCalledTimes(2)
  })
})

describe('deleteJob', () => {
  it('deletes the job with its pods', async () => {
    const deleteNamespacedJob = vi.fn().mockResolvedValue({})
    const instance = { batchApi: { deleteNamespacedJob } } as unknown as KubernetesInstance

    await deleteJob(instance, env, 'job')

    expect(deleteNamespacedJob).toHaveBeenCalledWith({
      name: 'job',
      namespace: 'demo',
      gracePeriodSeconds: 0,
      propagationPolicy: 'Background',
    })
  })

  it('ignores a job that is already gone', async () => {
    const deleteNamespacedJob = vi.fn().mockRejectedValue(httpError(404))
    const instance = { batchApi: { deleteNamespacedJob } } as unknown as KubernetesInstance

    await expect(deleteJob(instance, env, 'job')).resolves.toBeUndefined()
  })

  it('rethrows other errors', async () => {
    const deleteNamespacedJob = vi.fn().mockRejectedValue(httpError(500))
    const instance = { batchApi: { deleteNamespacedJob } } as unknown as KubernetesInstance

    await expect(deleteJob(instance, env, 'job')).rejects.toThrow()
  })
})

describe('awaitJobCompletion', () => {
  it('polls the job until it succeeded', async () => {
    const readNamespacedJobStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: {} })
      .mockResolvedValueOnce({ status: { succeeded: 1 } })
    const instance = { batchApi: { readNamespacedJobStatus } } as unknown as KubernetesInstance

    await awaitJobCompletion(instance, env, 'job', new AbortController().signal, 0)

    expect(readNamespacedJobStatus).toHaveBeenCalledTimes(2)
    expect(readNamespacedJobStatus).toHaveBeenCalledWith({ name: 'job', namespace: 'demo' })
  })

  it('fails with the message of the failed condition', async () => {
    const readNamespacedJobStatus = vi.fn().mockResolvedValue({
      status: { conditions: [{ type: 'Failed', status: 'True', message: 'BackoffLimitExceeded' }] },
    })
    const instance = { batchApi: { readNamespacedJobStatus } } as unknown as KubernetesInstance

    await expect(awaitJobCompletion(instance, env, 'job', new AbortController().signal, 0)).rejects.toThrow(
      'job job failed: BackoffLimitExceeded'
    )
  })

  it('deletes the job and throws once aborted', async () => {
    const deleteNamespacedJob = vi.fn().mockResolvedValue({})
    const readNamespacedJobStatus = vi.fn()
    const instance = { batchApi: { deleteNamespacedJob, readNamespacedJobStatus } } as unknown as KubernetesInstance
    const abort = new AbortController()
    abort.abort()

    await expect(awaitJobCompletion(instance, env, 'job', abort.signal, 0)).rejects.toBeInstanceOf(AbortError)
    expect(deleteNamespacedJob).toHaveBeenCalledTimes(1)
    expect(readNamespacedJobStatus).not.toHaveBeenCalled()
  })
})

describe('deleteJobAndWait', () => {
  it('waits until the job is gone', async () => {
    const deleteNamespacedJob = vi.fn().mockResolvedValue({})
    const readNamespacedJob = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(httpError(404))
    const instance = { batchApi: { deleteNamespacedJob, readNamespacedJob } } as unknown as KubernetesInstance

    await deleteJobAndWait(instance, env, 'job', new AbortController().signal, 0)

    expect(deleteNamespacedJob).toHaveBeenCalledTimes(1)
    expect(readNamespacedJob).toHaveBeenCalledTimes(2)
  })

  it('rethrows errors other than not found', async () => {
    const deleteNamespacedJob = vi.fn().mockResolvedValue({})
    const readNamespacedJob = vi.fn().mockRejectedValue(httpError(500))
    const instance = { batchApi: { deleteNamespacedJob, readNamespacedJob } } as unknown as KubernetesInstance

    await expect(deleteJobAndWait(instance, env, 'job', new AbortController().signal, 0)).rejects.toThrow()
  })
})

describe('stopJob', () => {
  it('deletes the pods without a grace period and returns once they are gone', async () => {
    const deleteNamespacedJob = vi.fn().mockResolvedValue({})
    const pod = { metadata: { name: 'job-abc', deletionTimestamp: new Date() } }
    const listNamespacedPod = vi
      .fn()
      .mockResolvedValueOnce({ items: [pod] })
      .mockResolvedValueOnce({ items: [pod] })
      .mockResolvedValueOnce({ items: [] })
    const deleteNamespacedPod = vi.fn().mockRejectedValueOnce(httpError(404)).mockResolvedValue({})
    const instance = {
      batchApi: { deleteNamespacedJob },
      coreApi: { listNamespacedPod, deleteNamespacedPod },
    } as unknown as KubernetesInstance

    await stopJob(instance, env, 'job', 1000, 0)

    expect(deleteNamespacedJob).toHaveBeenCalled()
    expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'demo', labelSelector: 'job-name=job' })
    expect(listNamespacedPod).toHaveBeenCalledTimes(3)
    // also a pod the Job's deletion already ends with the default grace period
    expect(deleteNamespacedPod).toHaveBeenCalledTimes(2)
    expect(deleteNamespacedPod).toHaveBeenCalledWith({ name: 'job-abc', namespace: 'demo', gracePeriodSeconds: 0 })
  })

  it('fails when a pod is still there after the timeout', async () => {
    const instance = {
      batchApi: { deleteNamespacedJob: vi.fn().mockResolvedValue({}) },
      coreApi: {
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'job-abc' } }] }),
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
      },
    } as unknown as KubernetesInstance

    await expect(stopJob(instance, env, 'job', 0, 0)).rejects.toThrow('the pods of job were still there after 0s')
  })
})

describe('awaitDeployRollout', () => {
  const readiness = {
    podSelector: 'hammerkit.dev/id=api',
    timeout: null,
    timeoutMessage: 'api did not get ready',
    generation: 2,
  }

  it('waits until every pod is of the new spec and ready, the old pod ready meanwhile', async () => {
    const readNamespacedDeployment = vi
      .fn()
      // the old pod serves, the new spec is not seen yet
      .mockResolvedValueOnce({
        status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
      })
      // the new pod starts beside the old one
      .mockResolvedValueOnce({
        status: { observedGeneration: 2, replicas: 2, updatedReplicas: 1, availableReplicas: 1 },
      })
      .mockResolvedValueOnce({
        status: { observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
      })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }) },
    } as unknown as KubernetesInstance

    await awaitDeployRollout(instance, env, 'api', readiness, 0)

    expect(readNamespacedDeployment).toHaveBeenCalledTimes(3)
  })

  it('fails once Kubernetes gave up on the rollout', async () => {
    const readNamespacedDeployment = vi.fn().mockResolvedValue({
      status: {
        observedGeneration: 2,
        replicas: 2,
        updatedReplicas: 1,
        availableReplicas: 1,
        conditions: [{ type: 'Progressing', reason: 'ProgressDeadlineExceeded', message: 'it timed out' }],
      },
    })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }) },
    } as unknown as KubernetesInstance

    await expect(awaitDeployRollout(instance, env, 'api', readiness, 0)).rejects.toThrow(
      'api did not get ready: it timed out'
    )
  })

  it('fails at once when the new pod keeps crashing, which a move then puts back', async () => {
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValue({ status: { observedGeneration: 2, replicas: 2, updatedReplicas: 1, availableReplicas: 1 } })
    const crashing = {
      metadata: { name: 'api-2' },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'api',
            image: 'api:2',
            restartCount: 2,
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: { terminated: { exitCode: 1, reason: 'Error' } },
          },
        ],
      },
    }
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod: vi.fn().mockResolvedValue({ items: [crashing] }) },
    } as unknown as KubernetesInstance
    await expect(
      awaitDeployRollout(instance, env, 'api', { ...readiness, container: 'api', subject: 'service api' }, 0)
    ).rejects.toThrow(
      'service api can not become ready, it keeps crashing: it exited with code 1 (Error), restarted 2 times'
    )
  })

  it('stops when it is aborted', async () => {
    const readNamespacedDeployment = vi.fn().mockResolvedValue({ status: { observedGeneration: 1 } })
    const instance = {
      appsApi: { readNamespacedDeployment },
      coreApi: { listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }) },
    } as unknown as KubernetesInstance
    const abort = new AbortController()
    const waiting = awaitDeployRollout(instance, env, 'api', { ...readiness, signal: abort.signal }, 5)
    abort.abort()
    await expect(waiting).rejects.toBeInstanceOf(AbortError)
  })
})

describe('watchKeptPods', () => {
  const readiness = { podSelector: 'hammerkit.dev/id=dev', timeout: null, timeoutMessage: '', subject: 'service dev' }
  const pod = (restartCount: number) => ({
    metadata: { name: 'dev-1' },
    status: {
      phase: 'Running',
      containerStatuses: [{ name: 'dev', restartCount, ready: true, state: { running: {} } }],
    },
  })
  const cluster = (counts: number[], available = 1) => {
    const listNamespacedPod = vi.fn()
    for (const count of counts) {
      listNamespacedPod.mockResolvedValueOnce({ items: [pod(count)] })
    }
    return {
      coreApi: { listNamespacedPod },
      appsApi: { readNamespacedDeployment: vi.fn().mockResolvedValue({ status: { availableReplicas: available } }) },
    } as unknown as KubernetesInstance
  }
  // a clock that moves a second with every look
  const clock = () => {
    let at = 0
    return () => (at += 1000)
  }

  it('lets a pod that goes on running with the changed files stay', async () => {
    const instance = cluster([2, 2, 2, 2])
    await watchKeptPods(instance, env, 'dev', readiness, 3000, 0, clock())
    expect(instance.coreApi.listNamespacedPod).toHaveBeenCalledTimes(3)
  })

  it('fails when its container restarts after it got them', async () => {
    await expect(watchKeptPods(cluster([2, 3]), env, 'dev', readiness, 10_000, 0, clock())).rejects.toThrow(
      'service dev stopped working with the changed files, its container restarted'
    )
  })

  it('fails when the Deployment has no ready pod any more', async () => {
    await expect(watchKeptPods(cluster([0], 0), env, 'dev', readiness, 10_000, 0, clock())).rejects.toThrow(
      'service dev stopped working with the changed files, it has no ready pod'
    )
  })
})
