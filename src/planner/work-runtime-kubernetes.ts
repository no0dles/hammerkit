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
import { V1EnvVar, V1Job, V1Pod } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader } from '../kubernetes/apply'
import { ensureKubernetesServiceExists } from '../kubernetes/ensure-kubernetes-service-exists'
import { ensureKubernetesDeploymentExists } from '../kubernetes/ensure-kubernetes-deployment-exists'
import { ensurePersistentData } from '../kubernetes/ensure-persistent-data'
import { awaitJobState, awaitRunningState } from '../kubernetes/await-running-state'
import { getKubernetesPersistence, getVolumeMounts, getVolumes } from '../kubernetes/volumes'
import { getResourceName } from '../kubernetes/resources'
import { ensureIngress } from '../kubernetes/ensure-ingress'

export function kubernetesTaskRuntime(
  task: WorkItem<ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment
): WorkRuntime<TaskState> {
  const instance = createKubernetesInstances(kubernetes)
  return {
    initialize(item: State<TaskState>): Promise<void> {
      return Promise.resolve()
    },
    restore(environment: Environment, path: string): Promise<void> {
      throw new Error('not implemented')
    },
    archive(environment: Environment, path: string): Promise<void> {
      throw new Error('not implemented')
    },
    async execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      const envs = getEnvironmentVariables(task.data.envs)

      const persistence = await getKubernetesPersistence(task)
      await ensurePersistentData(instance, kubernetes, environment, task, persistence)

      const podName = `${task.name}-${options.stateKey}`
      let i = 0
      for (const cmd of task.data.cmds) {
        const spec: V1Job = {
          kind: 'Job',
          apiVersion: 'batch/v1',
          metadata: {
            namespace: kubernetes.namespace,
            name: podName,
          },
          spec: {
            template: {
              spec: {
                restartPolicy: 'Never',
                containers: [
                  {
                    image: task.data.image,
                    command: [cmd.parsed.command],
                    args: cmd.parsed.args,
                    workingDir: cmd.cwd,
                    env: Object.entries(envs).map<V1EnvVar>(([key, value]) => ({ name: key, value })),
                    name: `cmd-${++i}`,
                    volumeMounts: getVolumeMounts(persistence),
                  },
                ],
                volumes: getVolumes(persistence),
              },
            },
            backoffLimit: 1,
          },
        }
        try {
          const pod = await apply(
            instance,
            {
              kind: 'Job',
              apiVersion: 'batch/v1',
              metadata: {
                namespace: kubernetes.namespace,
                name: podName,
              },
            },
            spec
          )
          if (!pod.status?.succeeded) {
            await awaitJobState(instance, kubernetes, pod.metadata?.name!)
          }
          task.status.write('debug', 'pod completed')
          await instance.batchApi.deleteNamespacedJob(podName, kubernetes.namespace)
        } catch (e) {
          throw e
        }
      }
    },
    stop(): Promise<void> {
      throw new Error('not implemented')
    },
    remove(): Promise<void> {
      //throw new Error('not implemented')
      return Promise.resolve()
    },
  }
}
export function kubernetesServiceRuntime(
  service: WorkItem<ContainerWorkService>,
  kubernetes: WorkKubernetesEnvironment
): WorkRuntime<ServiceState> {
  const instance = createKubernetesInstances(kubernetes)
  return {
    initialize(item: State<ServiceState>): Promise<void> {
      //throw new Error('not implemented')
      return Promise.resolve()
    },
    restore(environment: Environment, path: string): Promise<void> {
      throw new Error('not implemented')
    },
    archive(environment: Environment, path: string): Promise<void> {
      throw new Error('not implemented')
    },
    stop(): Promise<void> {
      throw new Error('not implemented')
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
      try {
        const spec: KubernetesObjectHeader = {
          kind: 'Deployment',
          apiVersion: 'apps/v1',
          metadata: {
            namespace: kubernetes.namespace,
            name: service.name.replace(/:/, '-'),
          },
        }
        const status = await instance.objectApi.delete(spec)
      } catch (e) {
        // TODO
      }
      // TODO volumes
    },
  }
}

export function kubernetesForwardRuntime(service: WorkItem<KubernetesWorkService>): WorkRuntime<ServiceState> {
  return {
    initialize(item: State<ServiceState>): Promise<void> {
      throw new Error('not implemented')
    },
    async restore(environment: Environment, path: string): Promise<void> {},
    async archive(environment: Environment, path: string): Promise<void> {},
    async remove(): Promise<void> {},
    async execute(environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      // TODO migrate away from kubectl
      await kubernetesService(service, options)
    },
    stop(): Promise<void> {
      throw new Error('not implemented')
    },
  }
}
