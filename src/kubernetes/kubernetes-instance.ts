import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  Exec,
  KubeConfig,
  KubernetesObjectApi,
  NetworkingV1Api,
  Watch,
} from '@kubernetes/client-node'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

export interface KubernetesInstance {
  watch: Watch
  exec: Exec
  objectApi: KubernetesObjectApi
  coreApi: CoreV1Api
  appsApi: AppsV1Api
  networkingApi: NetworkingV1Api
  batchApi: BatchV1Api
}

export function createKubernetesInstances(kubernetes: WorkKubernetesEnvironment): KubernetesInstance {
  const kc = new KubeConfig()

  if (kubernetes.kubeConfig) {
    kc.loadFromFile(kubernetes.kubeConfig)
  } else {
    kc.loadFromDefault()
  }

  kc.setCurrentContext(kubernetes.context)

  const coreApi = kc.makeApiClient(CoreV1Api)
  const batchApi = kc.makeApiClient(BatchV1Api)
  const appsApi = kc.makeApiClient(AppsV1Api)
  const networkingApi = kc.makeApiClient(NetworkingV1Api)
  const objectApi = kc.makeApiClient(KubernetesObjectApi)
  const exec = new Exec(kc)
  const watch = new Watch(kc)

  return {
    objectApi,
    networkingApi,
    watch,
    exec,
    appsApi,
    coreApi,
    batchApi,
  }
}
