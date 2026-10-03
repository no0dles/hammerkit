import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { BuildFileEnvironmentSchemaHttpRoute } from '../schema/build-file-environment-schema-http-route'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { KubernetesObject } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'

// Gateway API HTTPRoute (gateway.networking.k8s.io/v1) is a CRD, not a core
// resource, so it is created through the generic `apply()` / objectApi instead
// of a typed client. Only the fields hammerkit sets are typed here.
interface V1HttpRoute extends KubernetesObject {
  spec: {
    parentRefs: { name: string; namespace?: string }[]
    hostnames: string[]
    rules: {
      matches: { path: { type: string; value: string } }[]
      backendRefs: { name: string; port: number }[]
    }[]
  }
}

export const HTTP_ROUTE_API_VERSION = 'gateway.networking.k8s.io/v1'
export const HTTP_ROUTE_KIND = 'HTTPRoute'

export async function ensureHttpRoute(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  route: BuildFileEnvironmentSchemaHttpRoute,
  service: WorkItem<ContainerWorkService>
) {
  const resource: V1HttpRoute & KubernetesObjectHeader = {
    apiVersion: HTTP_ROUTE_API_VERSION,
    kind: HTTP_ROUTE_KIND,
    metadata: {
      name: route.host,
      namespace: env.namespace,
      labels: {
        'hammerkit.dev/id': service.id(),
      },
    },
    spec: {
      parentRefs: [
        {
          name: route.gateway,
          ...(route.gatewayNamespace ? { namespace: route.gatewayNamespace } : {}),
        },
      ],
      hostnames: [route.host],
      rules: [
        {
          matches: [
            {
              path: {
                type: 'PathPrefix',
                value: route.path ?? '/',
              },
            },
          ],
          backendRefs: [
            {
              name: getResourceName(service),
              port: route.servicePort ?? service.data.ports[0].containerPort,
            },
          ],
        },
      ],
    },
  }

  return await apply(instance, resource)
}
