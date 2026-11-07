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
import {
  V1Container,
  V1Deployment,
  V1DeploymentSpec,
  V1EnvVar,
  V1HostAlias,
  V1PodTemplateSpec,
  V1Probe,
} from '@kubernetes/client-node'
import { createHash } from 'crypto'
import { getServiceHostname } from '../planner/utils/service-hostname'
import { apply, KubernetesObjectHeader, replaceDeployment } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { awaitDeployRollout, awaitDeployRunningState, DeployReadiness, watchKeptPods } from './await-running-state'
import { getItemLabels, getItemSelector, getResourceName } from './resources'
import { getHealthcheckTimeoutMessage } from '../planner/work-healthcheck'
import { getKubernetesResources } from './container-resources'
import { getContainerSecurity, getPodPlacement } from './job-placement'
import { getNetworkLabels } from './network-policy'
import { getProxylessEnvironment } from '../network/egress-proxy'
import { serviceRollouts } from './service-rollouts'

// what the service was created from, to tell a changed one
export const DEFINITION_LABEL = 'hammerkit.dev/definition'

// how often a starting container is checked: as the liveness probe
const STARTUP_PERIOD_SECONDS = 5

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
  // the healthcheck's `timeout` for each start: until it passed once, the liveness probe
  // doesn't kill a container that starts slowly, and the wait fails it with the timeout
  const startupProbe: V1Probe | undefined =
    probe && service.data.healthcheck
      ? {
          ...probe,
          // a check more than the timeout holds, and one more for the first check's offset: the
          // wait fails it with the timeout before the kubelet restarts it
          failureThreshold: Math.ceil(service.data.healthcheck.timeout / (STARTUP_PERIOD_SECONDS * 1000)) + 2,
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
      // without a healthcheck a pod is ready as soon as its container runs, also one that
      // exits a second later: it counts once it ran this long without a restart
      minReadySeconds: probe ? 0 : MIN_READY_SECONDS,
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
              name: getServiceContainerName(service),
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
              startupProbe,
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
  const readiness: DeployReadiness = {
    podSelector: getItemSelector(service, env),
    timeout: service.data.healthcheck?.timeout ?? null,
    timeoutMessage: service.data.healthcheck
      ? getHealthcheckTimeoutMessage(service.name, service.data.healthcheck)
      : '',
    container: getServiceContainerName(service),
    subject: `service ${service.name}`,
    onWaiting: (text) => service.status.write('warn', `${service.name} ${text}`),
    ...(service.data.restarts !== null ? { restarts: service.data.restarts } : {}),
  }

  if (env.server?.serviceRun) {
    await rollOut(instance, env, service, deployment, readiness, rollout)
    return
  }

  const deploy = await apply(instance, deployment)

  if ((deploy.status?.availableReplicas ?? 0) > 0) {
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
 * to go where the old one runs (getClaimPodSpec), whose claims are usually attached to one
 * node at a time. When the execution ends before all its services are up, the worker puts
 * every Deployment it rolled back as it was (serviceRollouts).
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
  const pod = getPodTemplateHash(template, service.data.projectRoot)
  deployment.metadata.annotations = { ...deployment.metadata.annotations, [POD_ANNOTATION]: pod }
  const previous = rollout.previous
  if (
    previous &&
    previous.metadata?.annotations?.[POD_ANNOTATION] === pod &&
    previous.metadata?.labels?.[DEFINITION_LABEL] === definition &&
    isAvailable(previous)
  ) {
    // its pod would be the same but for the state it runs at: a service that watches its
    // files has them already (syncLiveFiles), and its pod stays
    serviceRollouts.add(env.namespace, deployment.metadata.name, previous)
    await relabelDeployment(instance, env.namespace, deployment.metadata.name, stateKey)
    service.status.write('info', `${service.name} watches its files, it got the changed ones and stays up`)
    // it goes on running with them: else the move does not get up, and gets them back
    await watchKeptPods(instance, env, deployment.metadata.name, { ...readiness, signal: rollout.signal })
    return
  }
  // put back, or removed, by the worker when the execution ends before its services are up
  serviceRollouts.add(env.namespace, deployment.metadata.name, rollout.previous)
  const applied = await replaceDeployment(instance, deployment)
  if (rollout.previous) {
    service.status.write('info', `${service.name} changed, its new pod takes over once it is ready`)
  }
  await awaitDeployRollout(instance, env, deployment.metadata.name, {
    ...readiness,
    podSelector: `${readiness.podSelector},hammerkit.dev/state=${stateKey},${DEFINITION_LABEL}=${definition}`,
    generation: applied.metadata?.generation ?? 0,
    signal: rollout.signal,
  })
}

// the pod a Deployment of a service run makes, but for the state it runs at
export const POD_ANNOTATION = 'hammerkit.dev/pod'

// A move executes from a checkout of its own (`root`), which the pod's paths name: where the
// checkout is does not count, as for getServiceDefinitionHash
export function getPodTemplateHash(template: V1PodTemplateSpec, root?: string): string {
  const labels = { ...template.metadata?.labels }
  delete labels['hammerkit.dev/state']
  const json = JSON.stringify({ ...template, metadata: { ...template.metadata, labels } })
  const escaped = root ? JSON.stringify(root).slice(1, -1) : ''
  return createHash('sha256')
    .update(escaped ? json.split(escaped).join('<checkout>') : json)
    .digest('hex')
    .slice(0, 32)
}

// a Deployment whose pods are all of its template and ready
function isAvailable(deployment: V1Deployment): boolean {
  const status = deployment.status
  return (
    !deployment.metadata?.deletionTimestamp &&
    (status?.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0) &&
    (status?.updatedReplicas ?? 0) >= 1 &&
    (status?.availableReplicas ?? 0) >= 1 &&
    (status?.replicas ?? 0) === (status?.updatedReplicas ?? 0)
  )
}

// The Deployment runs at the state `stateKey` now: its template, and so its pods, stay
async function relabelDeployment(
  instance: KubernetesInstance,
  namespace: string,
  name: string,
  stateKey: string
): Promise<void> {
  await instance.appsApi.patchNamespacedDeployment({
    name,
    namespace,
    body: [{ op: 'add', path: '/metadata/labels/hammerkit.dev~1state', value: stateKey }],
  })
}

// how long the container of a service without a healthcheck has to run before it counts as up
export const MIN_READY_SECONDS = 10

// The container of a service's pod that runs its command, beside the `debug` one.
export function getServiceContainerName(service: WorkItem<ContainerWorkService>): string {
  return service.name.replace(/:/, '-')
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
