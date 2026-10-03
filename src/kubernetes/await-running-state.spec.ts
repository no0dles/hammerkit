import { ApiException } from '@kubernetes/client-node'
import { awaitDeployRunningState, awaitRunningState, deleteJob } from './await-running-state'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

const env = { type: 'kubernetes', namespace: 'demo', context: 'ctx', httpRoutes: [] } as WorkKubernetesEnvironment

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

  it('polls the deployment until a replica is ready', async () => {
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ status: {} })
      .mockResolvedValueOnce({ status: { readyReplicas: 0 } })
      .mockResolvedValueOnce({ status: { readyReplicas: 1 } })
    const instance = { appsApi: { readNamespacedDeployment } } as unknown as KubernetesInstance

    await awaitDeployRunningState(instance, env, 'api', noDeadline, 0)

    expect(readNamespacedDeployment).toHaveBeenCalledTimes(3)
    expect(readNamespacedDeployment).toHaveBeenCalledWith({ name: 'api', namespace: 'demo' })
  })

  it('starts the deadline only once a pod runs and fails when it passes', async () => {
    const readNamespacedDeployment = vi.fn().mockResolvedValue({ status: { readyReplicas: 0 } })
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
    // two pending polls, then running at t=10s, failing once 20s passed
    expect(listNamespacedPod).toHaveBeenCalledTimes(3)
    expect(readNamespacedDeployment).toHaveBeenCalledTimes(5)
  })

  it('returns when a replica becomes ready within the deadline', async () => {
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ status: { readyReplicas: 0 } })
      .mockResolvedValueOnce({ status: { readyReplicas: 1 } })
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
