import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { V1Service } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getItemLabels, getResourceName } from './resources'
import { getVersion } from '../version'

// A service without ports gets a headless Service: a ClusterIP one needs a port,
// and its tasks reach every port of the pod, as on docker.
export async function ensureKubernetesServiceExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<WorkService>
) {
  const name = getResourceName(service, env)
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
      labels: getItemLabels(service, env),
    },
    spec: {
      type: 'ClusterIP',
      ...(headless ? { clusterIP: 'None' } : {}),
      // the pods of the service of this run, on a server where runs share the namespace
      selector: getItemLabels(service, env),
      ...(headless
        ? {}
        : {
            // a Service of more than one port needs a name for each
            ports: service.data.ports.map((port) => ({
              name: `tcp-${port.hostPort ?? port.containerPort}`,
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
