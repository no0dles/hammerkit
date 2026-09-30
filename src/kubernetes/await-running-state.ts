import { AbortError } from '../executer/abort'
import { listenOnAbort } from '../utils/abort-event'
import { statusCodeOf } from './apply'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'
import { V1Deployment } from '@kubernetes/client-node'

export function awaitRunningState(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  name: string,
  phase: string
) {
  return new Promise<void>((resolve, reject) => {
    const req = instance.watch.watch(
      `/api/v1/namespaces/${env.namespace}/pods`,
      {},
      (type, obj) => {
        if (obj.metadata.name === name && obj.metadata.namespace === env.namespace && obj.status.phase === phase) {
          req.then((r) => r.abort())
          resolve()
        }
      },
      (err) => {
        if (err.message === 'aborted') {
          return
        }
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }
    )
  })
}

// Wait for a job to finish by polling its status: resolves once it succeeded,
// rejects when it failed (its `Failed` condition, i.e. retries are exhausted).
// On abort the job is deleted — with its pods — and an AbortError is thrown, so
// a cancelled or timed-out task leaves nothing running on the cluster.
export async function awaitJobCompletion(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  name: string,
  abort: AbortSignal,
  pollInterval = 1000
): Promise<void> {
  for (;;) {
    if (abort.aborted) {
      await deleteJob(instance, env, name)
      throw new AbortError()
    }
    const job = await instance.batchApi.readNamespacedJobStatus(name, env.namespace)
    const status = job.body.status
    if (status?.succeeded) {
      return
    }
    const failed = status?.conditions?.find((c) => c.type === 'Failed' && c.status === 'True')
    if (failed) {
      throw new Error(`job ${name} failed: ${failed.message ?? failed.reason ?? 'unknown reason'}`)
    }
    await sleep(pollInterval, abort)
  }
}

function sleep(ms: number, abort: AbortSignal): Promise<void> {
  if (abort.aborted) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      listener.close()
      resolve()
    }, ms)
    // not aborted yet, so this callback can only fire later, after assignment
    const listener = listenOnAbort(abort, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export async function deleteJob(instance: KubernetesInstance, env: WorkKubernetesEnvironment, name: string) {
  try {
    await instance.batchApi.deleteNamespacedJob(name, env.namespace, undefined, undefined, 0, undefined, 'Background')
  } catch (e) {
    if (statusCodeOf(e) !== 404) {
      throw e
    }
  }
}

export function awaitDeployRunningState(instance: KubernetesInstance, env: WorkKubernetesEnvironment, name: string) {
  return new Promise<void>((resolve, reject) => {
    const req = instance.watch.watch(
      `/apis/apps/v1/namespaces/${env.namespace}/deployments`,
      {},
      (type, obj: V1Deployment) => {
        if (
          (obj &&
            obj.metadata?.name === name &&
            obj.metadata?.namespace === env.namespace &&
            obj.status?.readyReplicas) ??
          0 > 0
        ) {
          req.then((r) => r.abort())
          resolve()
        }
      },
      (err) => {
        if (err && err.message === 'aborted') {
          return
        }
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }
    )
  })
}
