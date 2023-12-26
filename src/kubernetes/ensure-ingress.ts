import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { BuildFileEnvironmentSchemaIngress } from '../schema/build-file-environment-schema-ingress'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { V1Ingress } from '@kubernetes/client-node'
import { apply } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'

export async function ensureIngress(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  ingress: BuildFileEnvironmentSchemaIngress,
  service: WorkItem<ContainerWorkService>
) {
  const resource: V1Ingress = {
    kind: 'Ingress',
    apiVersion: 'networking.k8s.io/v1',
    metadata: {
      name: ingress.host,
      namespace: env.namespace,
      annotations: {
        'cert-manager.io/cluster-issuer': 'hammerkit-issuer',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: ingress.host,
          http: {
            paths: [
              {
                path: ingress.path ?? '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: getResourceName(service),
                    port: {
                      number: ingress.servicePort ?? service.data.ports[0].containerPort,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: [
        {
          secretName: `${ingress.host}-tls`,
          hosts: [ingress.host],
        },
      ],
    },
  }
  return await apply(
    instance,
    {
      kind: 'Ingress',
      apiVersion: 'networking.k8s.io/v1',
      metadata: {
        namespace: env.namespace,
        name: ingress.host,
      },
    },
    resource
  )
}
