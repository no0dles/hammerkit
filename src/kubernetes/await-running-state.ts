import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'
import { V1Deployment, V1Job, V1PersistentVolumeClaim } from '@kubernetes/client-node'

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

export function awaitJobState(instance: KubernetesInstance, env: WorkKubernetesEnvironment, name: string) {
  return new Promise<void>((resolve, reject) => {
    const req = instance.watch.watch(
      `/apis/batch/v1/namespaces/${env.namespace}/jobs/${name}`,
      {},
      (type, obj: V1Job) => {
        if (obj && obj.metadata?.name === name && obj.metadata?.namespace === env.namespace && obj.status?.succeeded) {
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

export function awaitPvcBound(instance: KubernetesInstance, env: WorkKubernetesEnvironment, name: string) {
  return new Promise<V1PersistentVolumeClaim>((resolve, reject) => {
    const req = instance.watch.watch(
      `/api/v1/namespaces/${env.namespace}/persistentvolumeclaims`,
      {},
      (type, obj: V1PersistentVolumeClaim) => {
        if (
          (obj &&
            obj.metadata?.name === name &&
            obj.metadata?.namespace === env.namespace &&
            obj.status?.phase === 'Bound') ??
          0 > 0
        ) {
          req.then((r) => r.abort())
          resolve(obj)
        }
      },
      (err) => {
        if (err && err.message === 'aborted') {
          return
        }
        if (err) {
          reject(err)
        }
      }
    )
  })
}
