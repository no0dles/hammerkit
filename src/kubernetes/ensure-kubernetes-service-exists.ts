import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { V1Service } from '@kubernetes/client-node'
import { apply } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'
import { getVersion } from '../version'

export async function ensureKubernetesServiceExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<WorkService>
) {
  const name = getResourceName(service)

  const svc: V1Service = {
    kind: 'Service',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        'hammerkit.dev/id': service.cacheId(),
      },
      ports: service.data.ports.map((port) => ({
        port: port.hostPort ?? port.containerPort,
        targetPort: port.containerPort,
      })),
    },
  }

  return await apply(
    instance,
    {
      kind: 'Service',
      apiVersion: 'v1',
      metadata: {
        namespace: env.namespace,
        name,
      },
    },
    svc
  )
}
