import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { V1Service } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'
import { getVersion } from '../version'

export async function ensureKubernetesServiceExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<WorkService>
) {
  const name = getResourceName(service)

  const svc: V1Service & KubernetesObjectHeader = {
    kind: 'Service',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
      labels: {
        'hammerkit.dev/id': service.id(),
      },
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        'hammerkit.dev/id': service.id(),
      },
      ports: service.data.ports.map((port) => ({
        port: port.hostPort ?? port.containerPort,
        targetPort: port.containerPort,
      })),
    },
  }

  return await apply(instance, svc)
}
