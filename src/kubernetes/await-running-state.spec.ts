import { ApiException } from '@kubernetes/client-node'
import { awaitDeployRunningState, awaitRunningState, deleteJob } from './await-running-state'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

const env = { type: 'kubernetes', namespace: 'demo', context: 'ctx', ingresses: [] } as WorkKubernetesEnvironment

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
  it('polls the deployment until a replica is ready', async () => {
    const readNamespacedDeployment = vi
      .fn()
      .mockResolvedValueOnce({ status: {} })
      .mockResolvedValueOnce({ status: { readyReplicas: 0 } })
      .mockResolvedValueOnce({ status: { readyReplicas: 1 } })
    const instance = { appsApi: { readNamespacedDeployment } } as unknown as KubernetesInstance

    await awaitDeployRunningState(instance, env, 'api', 0)

    expect(readNamespacedDeployment).toHaveBeenCalledTimes(3)
    expect(readNamespacedDeployment).toHaveBeenCalledWith({ name: 'api', namespace: 'demo' })
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
