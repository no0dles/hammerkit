import { BatchV1Api, CoreV1Api, Exec, KubeConfig, KubernetesObjectApi, Watch } from '@kubernetes/client-node'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

export interface KubernetesInstance {
  watch: Watch
  exec: Exec
  objectApi: KubernetesObjectApi
  coreApi: CoreV1Api
  batchApi: BatchV1Api
}

export function createKubernetesInstances(kubernetes: WorkKubernetesEnvironment): KubernetesInstance {
  const kc = new KubeConfig()
  kc.loadFromDefault()
  kc.setCurrentContext(kubernetes.context)

  const coreApi = kc.makeApiClient(CoreV1Api)
  const batchApi = kc.makeApiClient(BatchV1Api)
  const objectApi = kc.makeApiClient(KubernetesObjectApi)
  const exec = new Exec(kc)
  const watch = new Watch(kc)

  return {
    objectApi,
    watch,
    exec,
    coreApi,
    batchApi,
  }
}
