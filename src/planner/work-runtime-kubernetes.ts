import { AbortError } from '../executer/abort'
import { ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { ContainerWorkService, KubernetesWorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'
import { TaskState } from '../executer/scheduler/task-state'
import { ContainerWorkTask } from './work-task'
import { WorkCommand } from './work-command'
import { WorkItem } from './work-item'
import { State } from '../executer/state'
import { Environment } from '../executer/environment'
import { kubernetesService } from '../executer/kubernetes-service'
import { WorkKubernetesEnvironment } from './work-environment'
import { createKubernetesInstances, KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { V1EnvVar, V1Job, V1Pod, V1PodSpec, V1VolumeMount } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from '../kubernetes/apply'
import { ensureKubernetesServiceExists } from '../kubernetes/ensure-kubernetes-service-exists'
import { DEFINITION_LABEL, ensureKubernetesDeploymentExists } from '../kubernetes/ensure-kubernetes-deployment-exists'
import { getServiceDefinitionHash } from './service-definition'
import { ensureNamespace } from '../kubernetes/ensure-namespace'
import { ensurePersistentData } from '../kubernetes/ensure-persistent-data'
import { NETWORK_GATE_CONTAINER } from '../kubernetes/network-gate'
import { awaitJobCompletion, deleteJob, deleteJobAndWait, stopJob } from '../kubernetes/await-running-state'
import { getKubernetesPersistence, getVolumeName, getWorkspacePodSpec } from '../kubernetes/volumes'
import { getItemLabels, getItemSelector, getResourceName } from '../kubernetes/resources'
import { ensureHttpRoute, HTTP_ROUTE_API_VERSION, HTTP_ROUTE_KIND } from '../kubernetes/ensure-http-route'
import findProcess from 'find-process'
import { getErrorMessage } from '../log'
import { getVersion } from '../version'
import { getKubernetesCommandText } from './utils/task-arguments'
import { restoreKubernetesData } from '../kubernetes/restore-kubernetes-data'
import { storeKubernetesData } from '../kubernetes/store-kubernetes-data'
import { removePersistentData } from '../kubernetes/remove-persistent-data'
import { forgetClaimState, isKeptClaim, recordClaimState, useClaimState } from '../kubernetes/kept-claims'
import { getKubernetesResources } from '../kubernetes/container-resources'
import { ensureKubernetesSecret, getKubernetesSecretRefs, removeKubernetesSecret } from '../kubernetes/secrets'
import {
  assertJobAccounts,
  getSecretHosts,
  ensureJobCredentials,
  getJobSecretSpec,
  JobSecret,
  JobSecretSpec,
  removeJobCredentials,
  splitJobSecrets,
} from '../kubernetes/job-secrets'
import {
  getContainerSecurity,
  getPodPlacement,
  getPodRuntimeClass,
  getRunLabelValue,
} from '../kubernetes/job-placement'
import {
  ensureKubernetesItemNetwork,
  getNetworkLabels,
  KubernetesItemNetwork,
  KubernetesNetworkScope,
  releaseKubernetesItemNetwork,
  removeAllKubernetesItemNetworks,
  RUN_LABEL,
} from '../kubernetes/network-policy'
import { getRunId } from '../utils/run-id'
import { getEffectiveNetwork, isLimitedNetwork } from './work-network'
import { canUseRunner, executeInRunner } from '../kubernetes/sandbox-runner'
import { describeSecretSource, getSecretName } from './work-secret'

async function listJobNames(
  instance: ReturnType<typeof createKubernetesInstances>,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkTask>
): Promise<string[]> {
  const jobs = await instance.batchApi.listNamespacedJob({
    namespace: kubernetes.namespace,
    labelSelector: getItemSelector(task, kubernetes),
  })
  return jobs.items.flatMap((job) => (job.metadata?.name ? [job.metadata.name] : []))
}

// The Secret of the values the server hands over and the one of the credentials the
// pod reads its own secrets with
async function removeTaskSecrets(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkTask>
): Promise<void> {
  await removeKubernetesSecret(instance, kubernetes, task)
  await removeJobCredentials(instance, kubernetes, task)
}

// The newest pod of a Job
async function getJobPod(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  job: string
): Promise<V1Pod | undefined> {
  const pods = await instance.coreApi.listNamespacedPod({
    namespace: kubernetes.namespace,
    labelSelector: `job-name=${job}`,
  })
  return pods.items
    .slice()
    .sort((a, b) =>
      (a.metadata?.creationTimestamp?.toISOString() ?? '').localeCompare(
        b.metadata?.creationTimestamp?.toISOString() ?? ''
      )
    )
    .pop()
}

// a task's log is kept to this, the run's own cap is smaller
const MAX_JOB_LOG_BYTES = 4 * 1024 * 1024

// What the command printed, as the task's output: read from the cluster once the Job
// has ended. Without a pod (it never started) there is nothing to say.
async function writeJobLogs(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkTask>,
  job: string,
  container: string
): Promise<void> {
  try {
    const pod = await getJobPod(instance, kubernetes, job)
    if (!pod?.metadata?.name) {
      return
    }
    const log = await instance.coreApi.readNamespacedPodLog({
      name: pod.metadata.name,
      namespace: kubernetes.namespace,
      container,
      limitBytes: MAX_JOB_LOG_BYTES,
    })
    for (const line of String(log ?? '').split(/\r?\n/)) {
      if (line.length > 0) {
        task.status.console('stdout', line)
      }
    }
  } catch (e) {
    task.status.write('debug', `the log of ${job} could not be read: ${getErrorMessage(e)}`)
  }
}

export type JobFailure = { type: 'error'; message: string } | { type: 'crash'; exitCode: number }

// the command of a Job exited with this code, as a crash on docker or a host
class JobCrash extends Error {
  constructor(readonly exitCode: number) {
    super(`exit code ${exitCode}`)
  }
}

// Why a Job failed: the network gate, an init container that could not read a secret, which
// names the secret, never its output (which is the provider's and can hold the value), or the
// exit code of the command.
export async function describeFailedJob(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  task: string,
  job: string,
  container: string,
  secrets: JobSecret[]
): Promise<JobFailure | undefined> {
  const pod = await getJobPod(instance, kubernetes, job).catch(() => undefined)
  for (const status of pod?.status?.initContainerStatuses ?? []) {
    const terminated = status.state?.terminated ?? status.lastState?.terminated
    if (!terminated || terminated.exitCode === 0) {
      continue
    }
    if (status.name === NETWORK_GATE_CONTAINER) {
      // the gate says why in its termination message
      return {
        type: 'error',
        message: `${task}: ${terminated.message?.trim() || 'the network policy did not take hold'}`,
      }
    }
    const secret = secrets.find((s) => `secret-${s.index}` === status.name)
    if (secret) {
      return {
        type: 'error',
        message: `secret ${getSecretName(secret.secret)} (${describeSecretSource(secret.secret)}) could not be read: ${
          terminated.reason ?? 'exit code'
        } ${terminated.exitCode}`,
      }
    }
  }
  const command = pod?.status?.containerStatuses?.find((status) => status.name === container)
  const terminated = command?.state?.terminated ?? command?.lastState?.terminated
  if (terminated && terminated.exitCode !== 0) {
    return { type: 'crash', exitCode: terminated.exitCode }
  }
  return undefined
}

/**
 * The containers of the Job of a command: the network gate first, nothing runs before the
 * item's policy holds, then the init containers that read its secrets, then the command. The
 * proxy's token (`network.secretEnv`) reaches the init containers through `secretSpec` only:
 * the command's container gets the proxy variables of a limited network without it.
 */
export function getTaskJobContainers(options: {
  task: WorkItem<ContainerWorkTask>
  cmd: WorkCommand
  container: string
  envs: { [key: string]: string }
  secrets: { env: V1EnvVar[]; mounts: V1VolumeMount[] }
  network: Pick<KubernetesItemNetwork, 'env' | 'initContainers'>
  secretSpec: JobSecretSpec
  mounts: V1VolumeMount[]
  kubernetes: WorkKubernetesEnvironment
}): Pick<V1PodSpec, 'initContainers' | 'containers'> {
  const { task, cmd, envs, secrets, network, secretSpec, kubernetes } = options
  // the arguments after `--` keep their `$` as text, Kubernetes expands `$(NAME)`
  const command = secretSpec.command(task.data.shell, getKubernetesCommandText(cmd))
  const initContainers = [...network.initContainers, ...secretSpec.initContainers]
  return {
    ...(initContainers.length > 0 ? { initContainers } : {}),
    containers: [
      {
        image: task.data.image,
        // through the task's shell, as on Docker
        command: command.command,
        args: command.args,
        workingDir: cmd.cwd,
        env: [
          ...Object.entries(envs).map<V1EnvVar>(([key, value]) => ({ name: key, value })),
          ...secrets.env,
          ...network.env,
          ...command.env,
        ],
        name: options.container,
        volumeMounts: [...options.mounts, ...secrets.mounts, ...secretSpec.mounts],
        ...getKubernetesResources(task.data.resources),
        ...getContainerSecurity(kubernetes, task.data.capAdd),
      },
    ],
  }
}

export function kubernetesTaskRuntime(
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment
): WorkRuntime<TaskState> {
  const instance = createKubernetesInstances(kubernetes)
  // on a server that keeps them, the task's claim stays after the run with the state of its
  // outputs, and the next run of the same source mounts them as they are (see kept-claims)
  const kept = isKeptClaim(task, kubernetes)
  const claim = getVolumeName(task, kubernetes)
  return {
    initialize(): Promise<void> {
      return Promise.resolve()
    },
    async restore(environment: Environment, path: string, stateKey?: string): Promise<void> {
      if (!kept) {
        await restoreKubernetesData(task, kubernetes, instance, environment, path)
        return
      }
      const reset = await forgetClaimState(instance, kubernetes, claim)
      await restoreKubernetesData(task, kubernetes, instance, environment, path, { reset })
      if (stateKey) {
        await recordClaimState(instance, kubernetes, claim, stateKey)
      }
    },
    async archive(environment: Environment, path: string): Promise<void> {
      await storeKubernetesData(task, kubernetes, instance, environment, path)
    },
    async execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      const envs = getEnvironmentVariables(task.data.envs)

      const persistence = await getKubernetesPersistence(task, kubernetes)
      const workspace = getWorkspacePodSpec(kubernetes, persistence, { name: task.name, pool: task.data.pool })

      // a shell of a sandbox: its commands go into the sandbox's runner, when it has one now
      if (canUseRunner(task, kubernetes, persistence)) {
        try {
          const result = await executeInRunner(instance, task, kubernetes, persistence, options.abort)
          if (result.type === 'crash') {
            options.state.set({ stateKey: options.stateKey, type: 'crash', exitCode: result.exitCode })
            return
          }
          // stopped while the runner started: no Job for it either
          if (result.type === 'canceled' || options.abort.aborted) {
            options.state.set({ stateKey: options.stateKey, type: 'canceled' })
            return
          }
          if (result.type === 'done') {
            return
          }
        } catch (e) {
          options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
          return
        }
      }

      await ensureNamespace(instance, kubernetes.namespace)
      try {
        // the task writes to it now: what it holds stops being the outputs of a state, and
        // goes, as a new claim would hold nothing
        const reset = kept && (await forgetClaimState(instance, kubernetes, claim))
        await ensurePersistentData(instance, kubernetes, environment, task, persistence, { reset })
      } catch (e) {
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      const server = kubernetes.server
      const { delivered, inJob } = splitJobSecrets(task.data.secrets, server)
      const secrets = getKubernetesSecretRefs(task, kubernetes, delivered)
      const admitted = environment.hosted?.accounts
      let secretHosts: string[]
      try {
        secretHosts = getSecretHosts(task, inJob, server)
        if (server) {
          assertJobAccounts(inJob, server, admitted)
        }
        await ensureKubernetesSecret(instance, kubernetes, task, delivered, environment)
      } catch (e) {
        await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      // the run its pods and limits belong to: on a server, the server's run; on a
      // sandbox, its proxy stays with the sandbox for the next runs
      const scope: KubernetesNetworkScope & { run: string } = {
        run: server ? getRunLabelValue(server.run) : getRunId(),
        ...(server?.workspace
          ? {
              sandbox: {
                label: server.workspace.label,
                ...(server.workspace.pod ? { pod: server.workspace.pod } : {}),
              },
            }
          : {}),
      }
      const labels = {
        ...getItemLabels(task, kubernetes),
        'hammerkit.dev/state': options.stateKey,
        ...workspace.labels,
        [RUN_LABEL]: scope.run,
        ...getNetworkLabels(kubernetes, task),
      }
      const placement = server ? getPodPlacement(server, task.data.pool) : null

      // The last job of a run stays: its state label is what currentStateKey
      // reads. Jobs from an earlier run of this task go before this one starts.
      for (const name of await listJobNames(instance, kubernetes, task)) {
        await deleteJobAndWait(instance, kubernetes, name, options.abort)
      }

      // the services the task needs by the names it lists them under, and the
      // NetworkPolicy and proxy of a limited network, both of this run
      let network: KubernetesItemNetwork
      try {
        network = await ensureKubernetesItemNetwork(instance, kubernetes, task, {
          followLog: true,
          secretHosts,
          ...scope,
        })
      } catch (e) {
        await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      try {
        const podName = getResourceName(task, kubernetes, '-job')
        let i = 0
        for (const cmd of task.data.cmds) {
          const container = `cmd-${++i}`
          let secretSpec: JobSecretSpec
          try {
            // made for each Job right before it, so a later command's token is as fresh
            const credentials = await ensureJobCredentials(instance, kubernetes, task, inJob, admitted)
            secretSpec = getJobSecretSpec(task, inJob, server, credentials, environment, network.secretEnv)
          } catch (e) {
            await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
            options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
            return
          }
          const spec: V1Job & KubernetesObjectHeader = {
            kind: 'Job',
            apiVersion: 'batch/v1',
            metadata: {
              namespace: kubernetes.namespace,
              name: podName,
              annotations: {
                'hammerkit.dev/version': getVersion(),
              },
              labels,
            },
            spec: {
              template: {
                metadata: {
                  annotations: {
                    'hammerkit.dev/version': getVersion(),
                  },
                  labels,
                },
                spec: {
                  ...getTaskJobContainers({
                    task,
                    cmd,
                    container,
                    envs,
                    secrets,
                    network,
                    secretSpec,
                    mounts: persistence.mounts.map((m) => m.mount),
                    kubernetes,
                  }),
                  volumes: [
                    ...persistence.volumes,
                    ...persistence.workspace,
                    ...secrets.volumes,
                    ...secretSpec.volumes,
                  ],
                  ...(workspace.affinity ? { affinity: workspace.affinity } : {}),
                  ...getPodRuntimeClass({ name: task.name, capAdd: task.data.capAdd }, kubernetes),
                  hostAliases: network.hostAliases,
                  restartPolicy: 'Never',
                  // on a server the pod is the build's: no token of the namespace, and the
                  // nodes of its pool
                  ...(placement
                    ? {
                        automountServiceAccountToken: false,
                        nodeSelector: placement.nodeSelector,
                        tolerations: placement.tolerations,
                      }
                    : {}),
                },
              },
              backoffLimit: server ? 0 : 1,
              parallelism: 1,
            },
          }
          try {
            const pod = await apply(instance, spec)

            if (!pod.status?.succeeded) {
              try {
                await awaitJobCompletion(instance, kubernetes, spec.metadata.name, options.abort)
              } catch (e) {
                if (!(e instanceof AbortError)) {
                  await writeJobLogs(instance, kubernetes, task, podName, container)
                  const failure = await describeFailedJob(instance, kubernetes, task.name, podName, container, inJob)
                  if (failure?.type === 'crash') {
                    throw new JobCrash(failure.exitCode)
                  }
                  throw new Error(failure?.message ?? getErrorMessage(e))
                }
                throw e
              }
            }
            await writeJobLogs(instance, kubernetes, task, podName, container)
            task.status.write('debug', 'pod completed')
            // its init containers are done with the credentials
            await removeJobCredentials(instance, kubernetes, task)
            if (i < task.data.cmds.length) {
              await deleteJobAndWait(instance, kubernetes, podName, options.abort)
            }
          } catch (e) {
            if (e instanceof AbortError) {
              // at once, so its policy can go (in finally) once the pod ended
              await stopJob(instance, kubernetes, podName).catch((e) =>
                task.status.write('error', `the job could not be stopped: ${getErrorMessage(e)}`)
              )
              await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
              options.state.set({ stateKey: options.stateKey, type: 'canceled' })
              return
            }
            await deleteJob(instance, kubernetes, podName).catch(() => undefined)
            options.state.set(
              e instanceof JobCrash
                ? { stateKey: options.stateKey, type: 'crash', exitCode: e.exitCode }
                : { stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) }
            )
            await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
            return
          }
        }
        // the finished job stays for its state, the values it read need not
        await removeTaskSecrets(instance, kubernetes, task)
        if (kept) {
          await recordClaimState(instance, kubernetes, claim, options.stateKey)
        }
      } finally {
        network.close()
        // once the run's pods ended: a cancelled job's pod is still terminating
        if (isLimitedNetwork(getEffectiveNetwork(task.data))) {
          await releaseKubernetesItemNetwork(instance, kubernetes, task, scope).catch((e) =>
            task.status.write('error', `remove of network policy failed ${getErrorMessage(e)}`)
          )
        }
      }
    },
    async stop(): Promise<void> {
      const jobs = await instance.batchApi.listNamespacedJob({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(task, kubernetes),
      })
      for (const job of jobs.items) {
        if (job.metadata?.name) {
          await stopJob(instance, kubernetes, job.metadata.name)
        }
      }

      const deployments = await instance.appsApi.listNamespacedDeployment({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(task, kubernetes),
      })
      for (const deploy of deployments.items) {
        if (deploy.metadata?.name) {
          await instance.appsApi.deleteNamespacedDeployment({
            name: deploy.metadata.name,
            namespace: kubernetes.namespace,
          })
        }
      }

      const pods = await instance.coreApi.listNamespacedPod({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(task, kubernetes),
      })
      for (const pod of pods.items) {
        if (pod.metadata?.name) {
          await instance.coreApi.deleteNamespacedPod({ name: pod.metadata.name, namespace: kubernetes.namespace })
        }
      }
      // the limits go last, once no pod of the task runs
      await removeAllKubernetesItemNetworks(instance, kubernetes, task)
    },
    async remove(): Promise<void> {
      await this.stop()

      await removePersistentData(instance, kubernetes, task)
      await removeTaskSecrets(instance, kubernetes, task)
    },
    async currentStateKey(): Promise<string | null> {
      if (kept) {
        // the server removes the Jobs of a run at its end, the claim says
        return useClaimState(instance, kubernetes, claim)
      }
      const jobs = await instance.batchApi.listNamespacedJob({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(task, kubernetes),
      })
      const completedStates = jobs.items
        .filter((j) => j.status?.succeeded && j.metadata?.labels?.['hammerkit.dev/state'])
        .map((j) => j.metadata!.labels!['hammerkit.dev/state'])
      const stateKey = completedStates[completedStates.length - 1] ?? null
      if (stateKey === null || !task.data.generates.some((g) => !g.inherited)) {
        return stateKey
      }
      // outputs live in the task's claim; without it the finished job left
      // nothing to reuse
      try {
        const found = await instance.coreApi.readNamespacedPersistentVolumeClaim({
          name: claim,
          namespace: kubernetes.namespace,
        })
        return found.metadata?.deletionTimestamp ? null : stateKey
      } catch (e) {
        if (statusCodeOf(e) === 404) {
          return null
        }
        throw e
      }
    },
  }
}

export function kubernetesServiceRuntime(
  service: WorkItem<ContainerWorkService>,
  kubernetes: WorkKubernetesEnvironment
): WorkRuntime<ServiceState> {
  const instance = createKubernetesInstances(kubernetes)
  return {
    // A Deployment left by an earlier `up` is the running service, so `down`
    // stops it and a run reuses it, as with a container on Docker. One whose
    // definition changed goes, with its limits, and is created anew.
    async initialize(state: State<ServiceState>): Promise<void> {
      const deployments = await instance.appsApi.listNamespacedDeployment({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(service, kubernetes),
      })
      const deployment = deployments.items[0]
      if (!deployment?.metadata?.name) {
        return
      }
      if (deployment.metadata.labels?.[DEFINITION_LABEL] !== getServiceDefinitionHash(service)) {
        service.status.write('info', `${service.name} changed since it was started, recreating it`)
        await this.stop()
        return
      }
      state.set({
        type: 'running',
        dns: { containerId: deployment.metadata.name },
        stateKey: deployment.metadata.labels?.['hammerkit.dev/state'] ?? '',
        remote: null,
      })
    },
    async restore(environment: Environment, path: string): Promise<void> {
      await restoreKubernetesData(service, kubernetes, instance, environment, path)
    },
    async archive(environment: Environment, path: string): Promise<void> {
      await storeKubernetesData(service, kubernetes, instance, environment, path)
    },
    async stop(): Promise<void> {
      const deployments = await instance.appsApi.listNamespacedDeployment({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(service, kubernetes),
      })
      for (const deployment of deployments.items) {
        if (deployment.metadata?.name) {
          await instance.appsApi.deleteNamespacedDeployment({
            name: deployment.metadata.name,
            namespace: kubernetes.namespace,
          })
        }
      }
      await removeKubernetesSecret(instance, kubernetes, service)
      // the limits go last, once the service's pods ended
      await removeAllKubernetesItemNetworks(instance, kubernetes, service)
    },
    async execute(environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      const persistence = await getKubernetesPersistence(service, kubernetes)
      await ensureNamespace(instance, kubernetes.namespace)
      await ensureKubernetesServiceExists(instance, kubernetes, service)
      await ensurePersistentData(instance, kubernetes, environment, service, persistence)
      await ensureKubernetesSecret(instance, kubernetes, service, service.data.secrets, environment)
      // on a server, the run's: its runs share the namespace, and the service goes with the run
      const network = await ensureKubernetesItemNetwork(instance, kubernetes, service, {
        followLog: false,
        run: kubernetes.server ? getRunLabelValue(kubernetes.server.run) : null,
      })
      await ensureKubernetesDeploymentExists(
        instance,
        kubernetes,
        service,
        persistence,
        getKubernetesSecretRefs(service, kubernetes, service.data.secrets),
        options.stateKey,
        network
      )

      const name = getResourceName(service, kubernetes)
      options.state.set({
        type: 'running',
        dns: { containerId: name },
        stateKey: options.stateKey,
        remote: null,
      })

      for (const route of kubernetes.httpRoutes.filter((r) => r.service === service.name)) {
        await ensureHttpRoute(instance, kubernetes, route, service)
      }
    },
    async remove(): Promise<void> {
      // HTTPRoutes are a CRD, so they are deleted by name through the generic
      // objectApi rather than listed (a list would error on clusters without the
      // Gateway API CRDs even when none are declared). Only the routes this
      // service declares are removed; a missing route (404) is fine.
      for (const route of kubernetes.httpRoutes.filter((r) => r.service === service.name)) {
        try {
          await instance.objectApi.delete({
            apiVersion: HTTP_ROUTE_API_VERSION,
            kind: HTTP_ROUTE_KIND,
            metadata: { name: route.host, namespace: kubernetes.namespace },
          })
        } catch (e) {
          if (statusCodeOf(e) !== 404) {
            throw e
          }
        }
      }

      const services = await instance.coreApi.listNamespacedService({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(service, kubernetes),
      })
      for (const service of services.items) {
        if (service.metadata?.name) {
          await instance.coreApi.deleteNamespacedService({
            name: service.metadata.name,
            namespace: kubernetes.namespace,
          })
        }
      }

      await this.stop()

      await removePersistentData(instance, kubernetes, service)
    },
    async currentStateKey(): Promise<string | null> {
      const deployments = await instance.appsApi.listNamespacedDeployment({
        namespace: kubernetes.namespace,
        labelSelector: getItemSelector(service, kubernetes),
      })
      const deployment = deployments.items[0]
      return deployment?.metadata?.labels?.['hammerkit.dev/state'] ?? null
    },
  }
}

export function kubernetesForwardRuntime(service: WorkItem<KubernetesWorkService>): WorkRuntime<ServiceState> {
  return {
    async initialize(item: State<ServiceState>): Promise<void> {
      for (const port of service.data.ports) {
        if (port.hostPort === null) {
          continue
        }

        const processes = await findProcess('port', port.hostPort)
        if (!processes || processes.length === 0) {
          continue
        }

        item.set({
          type: 'error',
          errorMessage: `Host port ${port.hostPort} already in use`,
          stateKey: null,
        })
      }
    },
    async restore(): Promise<void> {},
    async archive(): Promise<void> {},
    async remove(): Promise<void> {},
    async execute(_environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      await kubernetesService(service, options)
    },
    currentStateKey(): Promise<string | null> {
      return Promise.resolve(null)
    },
    async stop(): Promise<void> {},
  }
}
