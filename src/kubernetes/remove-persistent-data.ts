import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'

export async function removePersistentData(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkService | ContainerWorkTask>
) {
  const labelSelector = `hammerkit.dev/id=${task.id()}`
  const configmaps = await instance.coreApi.listNamespacedConfigMap({ namespace: kubernetes.namespace, labelSelector })
  for (const configMap of configmaps.items) {
    if (configMap.metadata?.name) {
      await instance.coreApi.deleteNamespacedConfigMap({
        name: configMap.metadata.name,
        namespace: kubernetes.namespace,
      })
    }
  }

  const pvcs = await instance.coreApi.listNamespacedPersistentVolumeClaim({
    namespace: kubernetes.namespace,
    labelSelector,
  })
  for (const pvc of pvcs.items) {
    if (pvc.metadata?.name) {
      await instance.coreApi.deleteNamespacedPersistentVolumeClaim({
        name: pvc.metadata.name,
        namespace: kubernetes.namespace,
      })
    }
  }
}
