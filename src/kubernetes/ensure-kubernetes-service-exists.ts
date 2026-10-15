import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { V1Service } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'
import { getVersion } from '../version'
import { getRunLabels } from './job-placement'

// A service without ports gets a headless Service: a ClusterIP one needs a port,
// and its tasks reach every port of the pod, as on docker.
export async function ensureKubernetesServiceExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<WorkService>
) {
  const name = getResourceName(service)
  const headless = service.data.ports.length === 0

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
        ...getRunLabels(env),
      },
    },
    spec: {
      type: 'ClusterIP',
      ...(headless ? { clusterIP: 'None' } : {}),
      selector: {
        'hammerkit.dev/id': service.id(),
      },
      ...(headless
        ? {}
        : {
            ports: service.data.ports.map((port) => ({
              port: port.hostPort ?? port.containerPort,
              targetPort: port.containerPort,
            })),
          }),
    },
  }

  // the clusterIP of a Service is fixed, so one from before its ports changed goes first
  const existing = await instance.coreApi
    .readNamespacedService({ name, namespace: env.namespace })
    .catch((e) => (statusCodeOf(e) === 404 ? null : Promise.reject(e)))
  if (existing && (existing.spec?.clusterIP === 'None') !== headless) {
    await instance.coreApi.deleteNamespacedService({ name, namespace: env.namespace }).catch((e) => {
      if (statusCodeOf(e) !== 404) {
        throw e
      }
    })
  }

  return await apply(instance, svc)
}
