import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import {
  ContainerWorkService,
  getHealthcheckCommand,
  getServiceCommand,
  getServiceWorkingDir,
} from '../planner/work-service'
import { KubernetesPersistence } from './volumes'
import { KubernetesSecretRefs } from './secrets'
import { V1Container, V1Deployment, V1EnvVar, V1HostAlias, V1Probe } from '@kubernetes/client-node'
import { getServiceHostname } from '../planner/utils/service-hostname'
import { apply, KubernetesObjectHeader } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { awaitDeployRunningState } from './await-running-state'
import { getResourceName } from './resources'
import { getHealthcheckTimeoutMessage } from '../planner/work-healthcheck'
import { getKubernetesResources } from './container-resources'
import { getProxylessEnvironment } from '../network/egress-proxy'

export async function ensureKubernetesDeploymentExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService>,
  persistence: KubernetesPersistence,
  secrets: KubernetesSecretRefs,
  stateKey: string,
  // the needed services by name, and the proxy of a limited network
  network: { env: V1EnvVar[]; hostAliases: V1HostAlias[]; initContainers: V1Container[] }
) {
  const envs = getEnvironmentVariables(service.data.envs)
  const name = getResourceName(service)
  const healthcheckCommand = getHealthcheckCommand(service.data)
  const serviceCommand = getServiceCommand(service.data, { kubernetes: true })
  const probe: V1Probe | undefined = healthcheckCommand
    ? {
        exec: {
          // the service itself, not through the proxy (see getProxylessEnvironment)
          command: withoutProxy(healthcheckCommand, network.env),
        },
        periodSeconds: 5,
        failureThreshold: 3,
      }
    : undefined
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
        'hammerkit.dev/state': stateKey,
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
            'hammerkit.dev/state': stateKey,
          },
        },
        spec: {
          // the pod resolves its own service name, as with Docker's Hostname
          hostname: getServiceHostname(service.name),
          hostAliases: network.hostAliases,
          initContainers: network.initContainers,
          containers: [
            {
              name: service.name.replace(/:/, '-'),
              image: service.data.image,
              workingDir: getServiceWorkingDir(service.data),
              env: [
                ...Object.entries(envs).map(([key, value]) => ({
                  name: key,
                  value: value,
                })),
                ...secrets.env,
                ...network.env,
              ],
              ...getKubernetesCommand(serviceCommand),
              ports: service.data.ports.map((p) => ({
                containerPort: p.containerPort,
              })),
              readinessProbe: probe,
              livenessProbe: probe,
              ...getKubernetesResources(service.data.resources),
              volumeMounts: [...persistence.mounts.map((m) => m.mount), ...secrets.mounts],
            },
            {
              name: 'debug',
              image: service.data.image,
              command: ['sleep'],
              args: ['3600'],
              volumeMounts: persistence.mounts.map((m) => m.mount),
            },
          ],
          volumes: [...persistence.volumes, ...secrets.volumes],
        },
      },
    },
  }
  const deploy = await apply(instance, deployment)

  if (deploy.status?.readyReplicas ?? 0 > 0) {
    return
  }

  await awaitDeployRunningState(instance, env, name, {
    podSelector: `hammerkit.dev/id=${service.id()}`,
    timeout: service.data.healthcheck?.timeout ?? null,
    timeoutMessage: service.data.healthcheck
      ? getHealthcheckTimeoutMessage(service.name, service.data.healthcheck)
      : '',
  })
}

// Kubernetes `command` replaces the image entrypoint and `args` its command.
// A shell service sets both; an exec-form `cmd` keeps the established mapping
// (first token as `command`, the rest as `args`).
function getKubernetesCommand(command: { entrypoint: string[] | null; cmd: string[] | null }): {
  command?: string[]
  args?: string[]
} {
  if (command.entrypoint && command.cmd) {
    return { command: command.entrypoint, args: command.cmd }
  }
  if (command.cmd) {
    return { command: [command.cmd[0]], args: command.cmd.slice(1) }
  }
  return {}
}

// A probe runs with the container's variables, so it empties the proxy ones
// through `env`, as a Docker healthcheck does with the exec's own variables.
function withoutProxy(command: string[], env: V1EnvVar[]): string[] {
  const proxyless = getProxylessEnvironment(Object.fromEntries(env.map((e) => [e.name, e.value ?? ''])))
  return proxyless ? ['env', ...Object.keys(proxyless).map((key) => `${key}=`), ...command] : command
}
