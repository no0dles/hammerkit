import { AbortError } from '../executer/abort'
import { ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { ContainerWorkService, KubernetesWorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'
import { TaskState } from '../executer/scheduler/task-state'
import { ContainerWorkTask } from './work-task'
import { WorkItem } from './work-item'
import { State } from '../executer/state'
import { Environment } from '../executer/environment'
import { kubernetesService } from '../executer/kubernetes-service'
import { WorkKubernetesEnvironment } from './work-environment'
import { createKubernetesInstances, KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { V1EnvVar, V1Job, V1Pod } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from '../kubernetes/apply'
import { ensureKubernetesServiceExists } from '../kubernetes/ensure-kubernetes-service-exists'
import { ensureKubernetesDeploymentExists } from '../kubernetes/ensure-kubernetes-deployment-exists'
import { ensureNamespace } from '../kubernetes/ensure-namespace'
import { ensurePersistentData } from '../kubernetes/ensure-persistent-data'
import { awaitJobCompletion, deleteJob, deleteJobAndWait } from '../kubernetes/await-running-state'
import { getKubernetesPersistence, getVolumeName } from '../kubernetes/volumes'
import { getResourceName } from '../kubernetes/resources'
import { ensureHttpRoute, HTTP_ROUTE_API_VERSION, HTTP_ROUTE_KIND } from '../kubernetes/ensure-http-route'
import findProcess from 'find-process'
import { getErrorMessage } from '../log'
import { getVersion } from '../version'
import { restoreKubernetesData } from '../kubernetes/restore-kubernetes-data'
import { storeKubernetesData } from '../kubernetes/store-kubernetes-data'
import { removePersistentData } from '../kubernetes/remove-persistent-data'
import { getKubernetesResources } from '../kubernetes/container-resources'
import { ensureKubernetesSecret, getKubernetesSecretRefs, removeKubernetesSecret } from '../kubernetes/secrets'
import {
  assertSecretsReachable,
  ensureJobCredentials,
  getJobSecretSpec,
  JobSecret,
  JobSecretSpec,
  removeJobCredentials,
  splitJobSecrets,
} from '../kubernetes/job-secrets'
import { getPodPlacement, getRunLabels } from '../kubernetes/job-placement'
import {
  ensureKubernetesItemNetwork,
  KubernetesItemNetwork,
  removeKubernetesItemNetwork,
} from '../kubernetes/network-policy'
import { describeSecretSource, getSecretName } from './work-secret'

async function listJobNames(
  instance: ReturnType<typeof createKubernetesInstances>,
  kubernetes: WorkKubernetesEnvironment,
  task: WorkItem<ContainerWorkTask>
): Promise<string[]> {
  const jobs = await instance.batchApi.listNamespacedJob({
    namespace: kubernetes.namespace,
    labelSelector: `hammerkit.dev/id=${task.id()}`,
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

// Why a Job failed when it was not the command: an init container that could not
// read a secret names the secret, never its output (which is the provider's and
// can hold the value).
async function describeFailedJob(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  job: string,
  secrets: JobSecret[]
): Promise<string | undefined> {
  const pod = await getJobPod(instance, kubernetes, job).catch(() => undefined)
  for (const status of pod?.status?.initContainerStatuses ?? []) {
    const terminated = status.state?.terminated ?? status.lastState?.terminated
    if (!terminated || terminated.exitCode === 0) {
      continue
    }
    const secret = secrets.find((s) => `secret-${s.index}` === status.name)
    if (secret) {
      return `secret ${getSecretName(secret.secret)} (${describeSecretSource(secret.secret)}) could not be read: ${
        terminated.reason ?? 'exit code'
      } ${terminated.exitCode}`
    }
  }
  return undefined
}

export function kubernetesTaskRuntime(
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment
): WorkRuntime<TaskState> {
  const instance = createKubernetesInstances(kubernetes)
  return {
    initialize(): Promise<void> {
      return Promise.resolve()
    },
    async restore(environment: Environment, path: string): Promise<void> {
      await restoreKubernetesData(task, kubernetes, instance, environment, path)
    },
    async archive(environment: Environment, path: string): Promise<void> {
      await storeKubernetesData(task, kubernetes, instance, environment, path)
    },
    async execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      const envs = getEnvironmentVariables(task.data.envs)

      const persistence = await getKubernetesPersistence(task)

      await ensureNamespace(instance, kubernetes.namespace)
      try {
        await ensurePersistentData(instance, kubernetes, environment, task, persistence)
      } catch (e) {
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      const server = kubernetes.server
      const { delivered, inJob } = splitJobSecrets(task.data.secrets, server)
      const secrets = getKubernetesSecretRefs(task, delivered)
      let secretSpec: JobSecretSpec
      try {
        assertSecretsReachable(task, inJob)
        await ensureKubernetesSecret(instance, kubernetes, task, delivered, environment)
        const credentials = await ensureJobCredentials(instance, kubernetes, task, inJob)
        secretSpec = getJobSecretSpec(task, inJob, server, credentials, environment)
      } catch (e) {
        await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      const labels = {
        'hammerkit.dev/id': task.id(),
        'hammerkit.dev/state': options.stateKey,
        ...getRunLabels(kubernetes),
      }
      const placement = server ? getPodPlacement(server, task.data.pool) : null

      // The last job of a run stays: its state label is what currentStateKey
      // reads. Jobs from an earlier run of this task go before this one starts.
      for (const name of await listJobNames(instance, kubernetes, task)) {
        await deleteJobAndWait(instance, kubernetes, name, options.abort)
      }

      // the services the task needs by the names it lists them under, and the
      // NetworkPolicy and proxy of a limited network
      let network: KubernetesItemNetwork
      try {
        network = await ensureKubernetesItemNetwork(instance, kubernetes, task, { followLog: true })
      } catch (e) {
        await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
        options.state.set({ stateKey: options.stateKey, type: 'error', errorMessage: getErrorMessage(e) })
        return
      }
      try {
        const podName = `${task.name}-${options.stateKey}`
        let i = 0
        for (const cmd of task.data.cmds) {
          const container = `cmd-${++i}`
          const command = secretSpec.command(task.data.shell, cmd.cmd)
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
                  ...(secretSpec.initContainers.length > 0 ? { initContainers: secretSpec.initContainers } : {}),
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
                      name: container,
                      volumeMounts: [
                        ...persistence.mounts.map((m) => m.mount),
                        ...secrets.mounts,
                        ...secretSpec.mounts,
                      ],
                      ...getKubernetesResources(task.data.resources),
                    },
                  ],
                  volumes: [...persistence.volumes, ...secrets.volumes, ...secretSpec.volumes],
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
                  throw new Error((await describeFailedJob(instance, kubernetes, podName, inJob)) ?? getErrorMessage(e))
                }
                throw e
              }
            }
            await writeJobLogs(instance, kubernetes, task, podName, container)
            task.status.write('debug', 'pod completed')
            if (i < task.data.cmds.length) {
              await deleteJobAndWait(instance, kubernetes, podName, options.abort)
            }
          } catch (e) {
            if (e instanceof AbortError) {
              await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
              options.state.set({ stateKey: options.stateKey, type: 'canceled' })
              return
            }
            await deleteJob(instance, kubernetes, podName).catch(() => undefined)
            options.state.set({
              stateKey: options.stateKey,
              type: 'error',
              errorMessage: getErrorMessage(e),
            })
            await removeTaskSecrets(instance, kubernetes, task).catch(() => undefined)
            return
          }
        }
        // the finished job stays for its state, the values it read need not
        await removeTaskSecrets(instance, kubernetes, task)
      } finally {
        network.close()
        await removeKubernetesItemNetwork(instance, kubernetes, task).catch((e) =>
          task.status.write('error', `remove of network policy failed ${getErrorMessage(e)}`)
        )
      }
    },
    async stop(): Promise<void> {
      await removeKubernetesItemNetwork(instance, kubernetes, task)
      const jobs = await instance.batchApi.listNamespacedJob({
        namespace: kubernetes.namespace,
        labelSelector: `hammerkit.dev/id=${task.id()}`,
      })
      for (const pod of jobs.items) {
        if (pod.metadata?.name) {
          await instance.batchApi.deleteNamespacedJob({ name: pod.metadata.name, namespace: kubernetes.namespace })
        }
      }

      const deployments = await instance.appsApi.listNamespacedDeployment({
        namespace: kubernetes.namespace,
        labelSelector: `hammerkit.dev/id=${task.id()}`,
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
        labelSelector: `hammerkit.dev/id=${task.id()}`,
      })
      for (const pod of pods.items) {
        if (pod.metadata?.name) {
          await instance.coreApi.deleteNamespacedPod({ name: pod.metadata.name, namespace: kubernetes.namespace })
        }
      }
    },
    async remove(): Promise<void> {
      await this.stop()

      await removePersistentData(instance, kubernetes, task)
      await removeTaskSecrets(instance, kubernetes, task)
    },
    async currentStateKey(): Promise<string | null> {
      const jobs = await instance.batchApi.listNamespacedJob({
        namespace: kubernetes.namespace,
        labelSelector: `hammerkit.dev/id=${task.id()}`,
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
        const claim = await instance.coreApi.readNamespacedPersistentVolumeClaim({
          name: getVolumeName(task),
          namespace: kubernetes.namespace,
        })
        return claim.metadata?.deletionTimestamp ? null : stateKey
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
    initialize(): Promise<void> {
      return Promise.resolve()
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
        labelSelector: `hammerkit.dev/id=${service.id()}`,
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
      await removeKubernetesItemNetwork(instance, kubernetes, service)
    },
    async execute(environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      const persistence = await getKubernetesPersistence(service)
      await ensureNamespace(instance, kubernetes.namespace)
      await ensureKubernetesServiceExists(instance, kubernetes, service)
      await ensurePersistentData(instance, kubernetes, environment, service, persistence)
      await ensureKubernetesSecret(instance, kubernetes, service, service.data.secrets, environment)
      const network = await ensureKubernetesItemNetwork(instance, kubernetes, service, { followLog: false })
      await ensureKubernetesDeploymentExists(
        instance,
        kubernetes,
        service,
        persistence,
        getKubernetesSecretRefs(service, service.data.secrets),
        options.stateKey,
        network
      )

      const name = getResourceName(service)
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
        labelSelector: `hammerkit.dev/id=${service.id()}`,
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
        labelSelector: `hammerkit.dev/id=${service.id()}`,
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
