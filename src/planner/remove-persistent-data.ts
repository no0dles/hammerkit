import { KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { WorkKubernetesEnvironment } from './work-environment'
import { WorkItem } from './work-item'
import { ContainerWorkService } from './work-service'
import { ContainerWorkTask } from './work-task'

export async function removePersistentData(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkService | ContainerWorkTask>
) {
  const configmaps = await instance.coreApi.listNamespacedConfigMap(
    kubernetes.namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    `hammerkit.dev/id=${task.id()}`
  )
  for (const configMap of configmaps.body.items) {
    if (configMap.metadata?.name) {
      await instance.coreApi.deleteNamespacedConfigMap(configMap.metadata.name, kubernetes.namespace)
    }
  }

  const pvcs = await instance.coreApi.listNamespacedPersistentVolumeClaim(
    kubernetes.namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    `hammerkit.dev/id=${task.id()}`
  )
  for (const pvc of pvcs.body.items) {
    if (pvc.metadata?.name) {
      await instance.coreApi.deleteNamespacedPersistentVolumeClaim(pvc.metadata.name, kubernetes.namespace)
    }
  }
}
