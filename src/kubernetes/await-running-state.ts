import { AbortError } from '../executer/abort'
import { listenOnAbort } from '../utils/abort-event'
import { statusCodeOf } from './apply'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'
import { sleep as delay } from '../utils/sleep'

// The waits below poll instead of using the client's Watch: Watch aborts every
// request after 30s, which a pod or deployment still pulling its image outlasts.

export async function awaitRunningState(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  name: string,
  phase: string,
  pollInterval = 1000
): Promise<void> {
  for (;;) {
    const pod = await instance.coreApi.readNamespacedPod({ name, namespace: env.namespace })
    const current = pod.status?.phase
    if (current === phase) {
      return
    }
    if (current === 'Succeeded' || current === 'Failed') {
      throw new Error(`pod ${name} ended in phase ${current} before reaching ${phase}`)
    }
    await delay(pollInterval)
  }
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
    const job = await instance.batchApi.readNamespacedJobStatus({ name, namespace: env.namespace })
    const status = job.status
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

export async function deleteJob(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  name: string
): Promise<void> {
  try {
    await instance.batchApi.deleteNamespacedJob({
      name,
      namespace: env.namespace,
      gracePeriodSeconds: 0,
      propagationPolicy: 'Background',
    })
  } catch (e) {
    if (statusCodeOf(e) !== 404) {
      throw e
    }
  }
}

export interface DeployReadiness {
  // label selector of the deployment's pods
  podSelector: string
  // ms a pod may take to become ready once it runs; null = no deadline
  timeout: number | null
  // message when the deadline passes
  timeoutMessage: string
}

// Waits for a ready replica. The deadline only starts once a pod runs, so an
// image pull doesn't count against it (as on docker, where it starts after
// the container started).
export async function awaitDeployRunningState(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  name: string,
  readiness: DeployReadiness,
  pollInterval = 1000,
  now: () => number = Date.now
): Promise<void> {
  let runningSince: number | null = null
  for (;;) {
    const deployment = await instance.appsApi.readNamespacedDeployment({ name, namespace: env.namespace })
    if ((deployment.status?.readyReplicas ?? 0) > 0) {
      return
    }
    if (readiness.timeout !== null) {
      if (runningSince === null) {
        const pods = await instance.coreApi.listNamespacedPod({
          namespace: env.namespace,
          labelSelector: readiness.podSelector,
        })
        if (pods.items.some((pod) => pod.status?.phase === 'Running')) {
          runningSince = now()
        }
      } else if (now() - runningSince >= readiness.timeout) {
        throw new Error(readiness.timeoutMessage)
      }
    }
    await delay(pollInterval)
  }
}

// Delete a job and wait until it is gone: its name is reused for the task's next
// command (and the next run with the same state), and creating it while the old
// one is still being deleted would pick up the old job.
export async function deleteJobAndWait(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  name: string,
  abort: AbortSignal,
  pollInterval = 500
): Promise<void> {
  await deleteJob(instance, env, name)
  for (;;) {
    try {
      await instance.batchApi.readNamespacedJob({ name, namespace: env.namespace })
    } catch (e) {
      if (statusCodeOf(e) === 404) {
        return
      }
      throw e
    }
    if (abort.aborted) {
      throw new AbortError()
    }
    await sleep(pollInterval, abort)
  }
}
