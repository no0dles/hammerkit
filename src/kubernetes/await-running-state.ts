import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'

export function awaitRunningState(instance: KubernetesInstance, env: WorkKubernetesEnvironment, name: string) {
  return new Promise<void>((resolve, reject) => {
    const req = instance.watch.watch(
      `/api/v1/pods`,
      {},
      (type, obj) => {
        if (obj.metadata.name === name && obj.metadata.namespace === env.namespace && obj.status.phase === 'Running') {
          req.then((r) => r.abort())
          resolve()
        }
      },
      (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }
    )
  })
}
