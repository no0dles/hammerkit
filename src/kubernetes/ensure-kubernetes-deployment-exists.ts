import { getServiceDefinitionHash } from '../planner/service-definition'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import {
  ContainerWorkService,
  getHealthcheckCommand,
  getServiceCommand,
  getServiceWorkingDir,
} from '../planner/work-service'
import { getWorkspacePodSpec, KubernetesPersistence } from './volumes'
import { KubernetesSecretRefs } from './secrets'
import { V1Container, V1Deployment, V1DeploymentSpec, V1EnvVar, V1HostAlias, V1Probe } from '@kubernetes/client-node'
import { getServiceHostname } from '../planner/utils/service-hostname'
import { apply, KubernetesObjectHeader, replace } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { awaitDeployRollout, awaitDeployRunningState, DeployReadiness } from './await-running-state'
import { getItemLabels, getItemSelector, getResourceName } from './resources'
import { getHealthcheckTimeoutMessage } from '../planner/work-healthcheck'
import { getKubernetesResources } from './container-resources'
import { getContainerSecurity, getPodPlacement } from './job-placement'
import { getNetworkLabels } from './network-policy'
import { getProxylessEnvironment } from '../network/egress-proxy'
import { AbortError } from '../executer/abort'
import { getErrorMessage } from '../log'

// what the service was created from, to tell a changed one
export const DEFINITION_LABEL = 'hammerkit.dev/definition'

export async function ensureKubernetesDeploymentExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService>,
  persistence: KubernetesPersistence,
  secrets: KubernetesSecretRefs,
  stateKey: string,
  // the needed services by name, and the proxy of a limited network
  network: { env: V1EnvVar[]; hostAliases: V1HostAlias[]; initContainers: V1Container[] },
  // a service run (env.server.serviceRun): the Deployment the service has now, put back when
  // the new one does not get ready, and what stops the wait for it
  rollout: { previous?: V1Deployment; signal?: AbortSignal } = {}
) {
  const envs = getEnvironmentVariables(service.data.envs)
  const name = getResourceName(service, env)
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
  const server = env.server
  const placement = server ? getPodPlacement(server, undefined) : null
  const workspace = getWorkspacePodSpec(env, persistence)
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
        ...getItemLabels(service, env),
        'hammerkit.dev/state': stateKey,
        [DEFINITION_LABEL]: getServiceDefinitionHash(service),
      },
    },
    spec: {
      selector: {
        matchLabels: getItemLabels(service, env),
      },
      replicas: 1,
      template: {
        metadata: {
          labels: {
            ...getItemLabels(service, env),
            'hammerkit.dev/state': stateKey,
            ...workspace.labels,
            ...getNetworkLabels(env, service),
          },
        },
        spec: {
          ...(workspace.affinity ? { affinity: workspace.affinity } : {}),
          // the pod resolves its own service name, as with Docker's Hostname
          hostname: getServiceHostname(service.name),
          hostAliases: network.hostAliases,
          initContainers: network.initContainers,
          // on a server the pod is the build's: no token of the namespace, and the
          // nodes of the first pool
          ...(placement
            ? {
                automountServiceAccountToken: false,
                nodeSelector: placement.nodeSelector,
                tolerations: placement.tolerations,
              }
            : {}),
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
              ...getContainerSecurity(env),
            },
            {
              name: 'debug',
              image: service.data.image,
              command: ['sleep'],
              args: ['3600'],
              volumeMounts: persistence.mounts.map((m) => m.mount),
              ...getContainerSecurity(env),
            },
          ],
          volumes: [...persistence.volumes, ...persistence.workspace, ...secrets.volumes],
        },
      },
    },
  }
  const readiness = {
    podSelector: getItemSelector(service, env),
    timeout: service.data.healthcheck?.timeout ?? null,
    timeoutMessage: service.data.healthcheck
      ? getHealthcheckTimeoutMessage(service.name, service.data.healthcheck)
      : `${service.name} did not get ready`,
  }

  if (env.server?.serviceRun) {
    await rollOut(instance, env, service, deployment, readiness, rollout)
    return
  }

  const deploy = await apply(instance, deployment)

  if ((deploy.status?.readyReplicas ?? 0) > 0) {
    return
  }

  await awaitDeployRunningState(instance, env, name, readiness)
}

// how long the pods of a rolled service may take to get ready, as Kubernetes counts it
export const ROLLOUT_DEADLINE_SECONDS = 600

/**
 * The Deployment of a service of a service run, which keeps it from one commit to the next:
 * replaced as a whole (a merge would keep what the new one dropped, such as a variable) and
 * rolled. Its requests go to the pods it has until a new one is ready. A service with
 * volumes of its own stops first: two pods would write the same data. The new pod is asked
 * to go where the old one runs, whose claims are usually attached to one node at a time. A
 * rollout that does not get ready puts the Deployment back as it was.
 */
async function rollOut(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService>,
  deployment: V1Deployment & KubernetesObjectHeader,
  readiness: DeployReadiness,
  rollout: { previous?: V1Deployment; signal?: AbortSignal }
): Promise<void> {
  const spec = deployment.spec as V1DeploymentSpec
  const template = spec.template
  const definition = getServiceDefinitionHash(service)
  const stateKey = template.metadata?.labels?.['hammerkit.dev/state'] ?? ''
  const ownVolumes = service.data.volumes.some((volume) => !volume.inherited)
  spec.strategy = ownVolumes
    ? { type: 'Recreate' }
    : { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } }
  spec.progressDeadlineSeconds = ROLLOUT_DEADLINE_SECONDS
  // the pods of this definition and state, apart from the ones it rolls from
  template.metadata = {
    ...template.metadata,
    labels: { ...template.metadata?.labels, [DEFINITION_LABEL]: definition },
  }
  if (template.spec && !template.spec.affinity) {
    template.spec.affinity = {
      podAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          {
            weight: 100,
            podAffinityTerm: {
              labelSelector: { matchLabels: getItemLabels(service, env) },
              topologyKey: 'kubernetes.io/hostname',
            },
          },
        ],
      },
    }
  }
  const applied = await replace(instance, deployment)
  if (rollout.previous) {
    service.status.write('info', `${service.name} changed, its new pod takes over once it is ready`)
  }
  try {
    await awaitDeployRollout(instance, env, deployment.metadata.name, {
      ...readiness,
      podSelector: `${readiness.podSelector},hammerkit.dev/state=${stateKey},${DEFINITION_LABEL}=${definition}`,
      generation: applied.metadata?.generation ?? 0,
      signal: rollout.signal,
    })
  } catch (e) {
    const previous = rollout.previous
    if (previous?.spec && !(e instanceof AbortError)) {
      service.status.write('warn', `${service.name} did not get ready, putting back the pod it had`)
      await replace(instance, {
        kind: 'Deployment',
        apiVersion: 'apps/v1',
        metadata: {
          namespace: env.namespace,
          name: deployment.metadata.name,
          labels: previous.metadata?.labels,
          annotations: previous.metadata?.annotations,
        },
        spec: previous.spec,
      }).catch((inner) =>
        service.status.write('warn', `${service.name} could not be put back: ${getErrorMessage(inner)}`)
      )
    }
    throw e
  }
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
