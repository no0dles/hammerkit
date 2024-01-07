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
import { createKubernetesInstances } from '../kubernetes/kubernetes-instance'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { V1EnvVar, V1Job } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader } from '../kubernetes/apply'
import { ensureKubernetesServiceExists } from '../kubernetes/ensure-kubernetes-service-exists'
import { ensureKubernetesDeploymentExists } from '../kubernetes/ensure-kubernetes-deployment-exists'
import { ensurePersistentData } from '../kubernetes/ensure-persistent-data'
import { awaitJobState } from '../kubernetes/await-running-state'
import { getKubernetesPersistence } from '../kubernetes/volumes'
import { getResourceName } from '../kubernetes/resources'
import { ensureIngress } from '../kubernetes/ensure-ingress'
import findProcess from 'find-process'
import { getErrorMessage } from '../log'
import { getVersion } from '../version'
import { restoreKubernetesData } from '../kubernetes/restore-kubernetes-data'
import { storeKubernetesData } from '../kubernetes/store-kubernetes-data'
import { removePersistentData } from '../kubernetes/remove-persistent-data'

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

      await ensurePersistentData(instance, kubernetes, environment, task, persistence)

      const podName = `${task.name}-${options.stateKey}`
      let i = 0
      for (const cmd of task.data.cmds) {
        const spec: V1Job & KubernetesObjectHeader = {
          kind: 'Job',
          apiVersion: 'batch/v1',
          metadata: {
            namespace: kubernetes.namespace,
            name: podName,
            annotations: {
              'hammerkit.dev/version': getVersion(),
            },
            labels: {
              'hammerkit.dev/id': task.id(),
              'hammerkit.dev/state': options.stateKey,
            },
          },
          spec: {
            template: {
              metadata: {
                annotations: {
                  'hammerkit.dev/version': getVersion(),
                },
                labels: {
                  'hammerkit.dev/id': task.id(),
                  'hammerkit.dev/state': options.stateKey,
                },
              },
              spec: {
                containers: [
                  {
                    image: task.data.image,
                    command: [cmd.parsed.command],
                    args: cmd.parsed.args,
                    workingDir: cmd.cwd,
                    env: Object.entries(envs).map<V1EnvVar>(([key, value]) => ({ name: key, value })),
                    name: `cmd-${++i}`,
                    volumeMounts: persistence.mounts.map((m) => m.mount),
                  },
                ],
                volumes: persistence.volumes,
                restartPolicy: 'Never',
              },
            },
            backoffLimit: 1,
            parallelism: 1,
          },
        }
        try {
          const pod = await apply(instance, spec)

          if (!pod.status?.succeeded) {
            await awaitJobState(instance, kubernetes, spec.metadata.name)
          }
          task.status.write('debug', 'pod completed')
          await instance.batchApi.deleteNamespacedJob(podName, kubernetes.namespace)
        } catch (e) {
          options.state.set({
            stateKey: options.stateKey,
            type: 'error',
            errorMessage: getErrorMessage(e),
          })
          return
        }
      }
    },
    async stop(): Promise<void> {
      const jobs = await instance.batchApi.listNamespacedJob(
        kubernetes.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `hammerkit.dev/id=${task.id()}`
      )
      for (const pod of jobs.body.items) {
        if (pod.metadata?.name) {
          await instance.batchApi.deleteNamespacedJob(pod.metadata.name, kubernetes.namespace)
        }
      }

      const deployments = await instance.appsApi.listNamespacedDeployment(
        kubernetes.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `hammerkit.dev/id=${task.id()}`
      )
      for (const deploy of deployments.body.items) {
        if (deploy.metadata?.name) {
          await instance.appsApi.deleteNamespacedDeployment(deploy.metadata.name, kubernetes.namespace)
        }
      }

      const pods = await instance.coreApi.listNamespacedPod(
        kubernetes.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `hammerkit.dev/id=${task.id()}`
      )
      for (const pod of pods.body.items) {
        if (pod.metadata?.name) {
          await instance.coreApi.deleteNamespacedPod(pod.metadata.name, kubernetes.namespace)
        }
      }
    },
    async remove(): Promise<void> {
      await this.stop()

      await removePersistentData(instance, kubernetes, task)
    },
    currentStateKey(): Promise<string | null> {
      return Promise.resolve(null) // TODO implement
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
      const deployments = await instance.appsApi.listNamespacedDeployment(
        kubernetes.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `hammerkit.dev/id=${service.id()}`
      )
      for (const deployment of deployments.body.items) {
        if (deployment.metadata?.name) {
          await instance.appsApi.deleteNamespacedDeployment(deployment.metadata.name, kubernetes.namespace)
        }
      }
    },
    async execute(environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      const persistence = await getKubernetesPersistence(service)
      await ensureKubernetesServiceExists(instance, kubernetes, service)
      await ensurePersistentData(instance, kubernetes, environment, service, persistence)
      await ensureKubernetesDeploymentExists(instance, kubernetes, service, persistence)

      const name = getResourceName(service)
      options.state.set({
        type: 'running',
        dns: { containerId: name },
        stateKey: options.stateKey,
        remote: null,
      })

      const ingresses = kubernetes.ingresses.filter((i) => i.service === service.name)
      for (const ingress of ingresses) {
        await ensureIngress(instance, kubernetes, ingress, service)
      }
    },
    async remove(): Promise<void> {
      const ingresses = await instance.networkingApi.listNamespacedIngress(
        kubernetes.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `hammerkit.dev/id=${service.id()}`
      )
      for (const ingress of ingresses.body.items) {
        if (ingress.metadata?.name) {
          await instance.networkingApi.deleteNamespacedIngress(ingress.metadata.name, kubernetes.namespace)
        }
      }

      const services = await instance.coreApi.listNamespacedService(
        kubernetes.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `hammerkit.dev/id=${service.id()}`
      )
      for (const service of services.body.items) {
        if (service.metadata?.name) {
          await instance.coreApi.deleteNamespacedService(service.metadata.name, kubernetes.namespace)
        }
      }

      await this.stop()

      await removePersistentData(instance, kubernetes, service)
    },
    currentStateKey(): Promise<string | null> {
      return Promise.resolve(null) // TODO implement
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
      // TODO migrate away from kubectl
      await kubernetesService(service, options)
    },
    currentStateKey(): Promise<string | null> {
      return Promise.resolve(null)
    },
    async stop(): Promise<void> {},
  }
}
