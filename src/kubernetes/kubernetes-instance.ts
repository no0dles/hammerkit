import { CoreV1Api, Exec, KubeConfig, KubernetesObjectApi, Watch } from '@kubernetes/client-node'

export interface KubernetesInstance {
  watch: Watch
  exec: Exec
  objectApi: KubernetesObjectApi
  coreApi: CoreV1Api
}

export function createKubernetesInstances() {
  const kc = new KubeConfig()
  kc.loadFromDefault()

  const coreApi = kc.makeApiClient(CoreV1Api)
  const objectApi = kc.makeApiClient(KubernetesObjectApi)
  const exec = new Exec(kc)
  const watch = new Watch(kc)

  return {
    objectApi,
    watch,
    exec,
    coreApi,
  }
}
