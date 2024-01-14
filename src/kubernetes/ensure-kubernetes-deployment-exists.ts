import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { isContainerWorkServiceItem, WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { KubernetesPersistence } from './volumes'
import { V1Deployment, V1HostAlias } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader } from './apply'
import { getServiceIp } from './get-service-ip'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { awaitDeployRunningState } from './await-running-state'
import { getResourceName } from './resources'

export async function ensureKubernetesDeploymentExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService>,
  persistence: KubernetesPersistence
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
  const name = getResourceName(service)
  const deployment: V1Deployment & KubernetesObjectHeader = {
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: {
      namespace: env.namespace,
      name: name,
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
      labels: {
        'hammerkit.dev/id': service.id(),
      },
    },
    spec: {
      selector: {
        matchLabels: {
          'hammerkit.dev/id': service.id(),
        },
      },
      replicas: 1,
      template: {
        metadata: {
          labels: {
            'hammerkit.dev/id': service.id(),
          },
        },
        spec: {
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
              // TODO healthcheck
              volumeMounts: persistence.mounts.map((m) => m.mount),
            },
            {
              name: 'debug',
              image: service.data.image,
              command: ['sleep'],
              args: ['3600'],
              volumeMounts: persistence.mounts.map((m) => m.mount),
            },
          ],
          volumes: persistence.volumes,
        },
      },
    },
  }
  const deploy = await apply(instance, deployment)

  if (deploy.status?.readyReplicas ?? 0 > 0) {
    return
  }

  await awaitDeployRunningState(instance, env, name)
}
