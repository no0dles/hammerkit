import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { isContainerWorkServiceItem, WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { getContainer, KubernetesServiceVolume } from './volumes'
import { V1Container, V1Deployment, V1HostAlias } from '@kubernetes/client-node'
import { apply } from './apply'
import { getServiceIp } from './get-service-ip'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { getEnvironmentVariables } from '../environment/replace-env-variables'

export async function ensureKubernetesDeploymentExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService>,
  volumes: KubernetesServiceVolume[]
) {
  const hostAliases: V1HostAlias[] = []
  for (const need of service.needs) {
    if (!isContainerWorkServiceItem(need.service)) {
      continue
    }
    const ip = await getServiceIp(instance, env, need.service)
    if (!ip) {
      throw new Error(`unable to get service ip for ${need.name}`)
    }
    hostAliases.push({
      ip,
      hostnames: [need.name],
    })
  }
  const envs = getEnvironmentVariables(service.data.envs)
  const deployment: V1Deployment = {
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: {
      namespace: env.namespace,
      name: service.name.replace(/:/, '-'),
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
      selector: {
        matchLabels: {
          'hammerkit.dev/id': service.cacheId(),
        },
      },
      replicas: 1,
      template: {
        metadata: {
          labels: {
            'hammerkit.dev/id': service.cacheId(),
          },
        },
        spec: {
          initContainers: service.deps.reduce<V1Container[]>(
            (containers, d) => [...containers, ...getContainer(d.data, volumes)],
            []
          ),
          hostAliases: hostAliases,
          containers: [
            {
              name: service.name.replace(/:/, '-'),
              image: service.data.image,
              workingDir: service.data.cwd ?? undefined,
              env: Object.entries(envs).map(([key, value]) => ({
                name: key,
                value: value,
              })),
              command: service.data.cmd ? [service.data.cmd.parsed.command] : undefined,
              args: service.data.cmd ? service.data.cmd.parsed.args : undefined,
              ports: service.data.ports.map((p) => ({
                containerPort: p.containerPort,
              })),
              volumeMounts: volumes.map((v) => v.volumeMount),
            },
            {
              name: 'debug',
              image: 'alpine',
              command: ['sleep'],
              args: ['3600'],
              volumeMounts: volumes.map((v) => v.volumeMount),
            },
          ],
          volumes: volumes.map((v) => v.volume),
        },
      },
    },
  }
  return await apply(
    instance,
    {
      kind: 'Deployment',
      apiVersion: 'apps/v1',
      metadata: {
        namespace: env.namespace,
        name: service.name.replace(/:/, '-'),
      },
    },
    deployment
  )
}
