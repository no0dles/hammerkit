import { ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { convertToPosixPath, getContainerCli } from '../executer/execute-docker'
import { ContainerWorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'
import { ContainerWorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { State } from '../executer/state'
import { removeContainer } from '../docker/remove-container'
import { WorkItem } from './work-item'
import { Environment } from '../executer/environment'
import { dockerTask } from '../executer/docker-task'
import { dockerService } from '../executer/docker-service'
import Dockerode from 'dockerode'
import { usingContainer } from '../docker/using-container'
import { getArchivePaths } from '../executer/event-cache'
import { existsVolume, removeVolume } from '../executer/get-docker-executor'
import { dirname } from 'path'
import { getVolumeName } from './utils/plan-work-volume'
import { WorkDockerEnvironment } from './work-environment'

export function dockerTaskRuntime(
  task: WorkItem<ContainerWorkTask>,
  workEnvironment: WorkDockerEnvironment
): WorkRuntime<TaskState> {
  const docker = getContainerCli(workEnvironment)
  return {
    async initialize(state: State<TaskState>): Promise<void> {
      const currentTasks = await docker.listContainers({
        filters: {
          label: [`hammerkit-id=${task.id()}`],
        },
      })
      const currentTask = currentTasks[0]
      if (!currentTask) {
        return
      }

      const taskState = 'hammerkit-state' in currentTask.Labels ? currentTask.Labels['hammerkit-state'] : ''

      state.set({
        type: 'error',
        stateKey: taskState,
        errorMessage: `Container ${currentTask.Id} already running`,
      })
    },
    async restore(environment: Environment, path: string): Promise<void> {
      await restoreContainer(docker, environment, task, path)
    },
    async archive(environment: Environment, path: string): Promise<void> {
      await archiveContainer(docker, environment, task, path)
    },
    async stop(): Promise<void> {
      const containers = await docker.listContainers({
        all: true,
        filters: {
          label: [`hammerkit-id=${task.id()}`],
        },
      })
      for (const container of containers) {
        await removeContainer(docker.getContainer(container.Id))
      }
    },
    async execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      await dockerTask(docker, task, environment, options)
    },
    async remove(): Promise<void> {
      await this.stop()

      for (const generate of task.data.generates) {
        if (generate.inherited) {
          continue
        }

        const volumeName = getVolumeName(generate.path)
        const volumeExists = await existsVolume(docker, volumeName)
        if (volumeExists) {
          await removeVolume(docker, task.status, volumeName)
        } else {
          task.status.write('info', `generate ${generate} has no volume ${volumeName}`)
        }
      }
    },
    async currentStateKey(): Promise<string | null> {
      const containers = await docker.listContainers({
        all: true,
        filters: {
          label: [`hammerkit-id=${task.id()}`],
        },
      })
      const container = containers[0]
      if (!container) {
        return null
      }

      if (!container.Labels['hammerkit-state']) {
        return null
      }

      return container.Labels['hammerkit-state']
    },
  }
}

async function restoreContainer(
  docker: Dockerode,
  environment: Environment,
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  path: string
) {
  await usingContainer(
    docker,
    item,
    {
      Image: item.data.image,
      Tty: true,
      Entrypoint: 'sh',
      Cmd: ['-c', 'sleep 3600'],
      WorkingDir: convertToPosixPath(item.data.cwd),
      Labels: {
        app: 'hammerkit',
        'hammerkit-id': item.id(),
        'hammerkit-pid': process.pid.toString(),
        'hammerkit-type': 'task',
      },
      HostConfig: {
        AutoRemove: true,
        Binds:
          item.data.type === 'container-task'
            ? []
            : [...item.data.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`)],
      },
    },
    async (container) => {
      for (const generate of getArchivePaths(item.data, path)) {
        if (await environment.file.exists(generate.filename)) {
          await container.putArchive(environment.file.readStream(generate.filename), {
            path: dirname(generate.path),
          })
        }
      }
    }
  )
}

export function dockerServiceRuntime(
  service: WorkItem<ContainerWorkService>,
  workEnvironment: WorkDockerEnvironment
): WorkRuntime<ServiceState> {
  const docker = getContainerCli(workEnvironment)
  return {
    async initialize(state: State<ServiceState>): Promise<void> {
      const currentServices = await docker.listContainers({
        filters: {
          label: [`hammerkit-id=${service.id()}`],
        },
      })
      const currentService = currentServices[0]
      if (!currentService) {
        return
      }

      const servicePid =
        'hammerkit-pid' in currentService.Labels ? parseInt(currentService.Labels['hammerkit-pid']) : undefined
      const serviceState = 'hammerkit-state' in currentService.Labels ? currentService.Labels['hammerkit-state'] : ''

      state.set({
        type: 'running',
        remote: { containerId: currentService.Id, pid: servicePid },
        stateKey: serviceState,
        dns: {
          containerId: currentService.Id,
        },
      })
    },
    async stop(): Promise<void> {
      const containers = await docker.listContainers({
        all: true,
        filters: {
          label: [`hammerkit-id=${service.id()}`],
        },
      })
      for (const container of containers) {
        await removeContainer(docker.getContainer(container.Id))
      }
    },
    async remove(): Promise<void> {
      await this.stop()

      for (const volume of service.data.volumes) {
        const volumeExists = await existsVolume(docker, volume.name)
        if (!volumeExists) {
          continue
        }

        await removeVolume(docker, service.status, volume.name)
      }
    },
    async execute(environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      await dockerService(docker, service, options, environment)
    },
    async restore(environment: Environment, path: string): Promise<void> {
      await restoreContainer(docker, environment, service, path)
    },
    async archive(environment: Environment, path: string): Promise<void> {
      await archiveContainer(docker, environment, service, path)
    },
    async currentStateKey(): Promise<string | null> {
      const containers = await docker.listContainers({
        all: true,
        filters: {
          label: [`hammerkit-id=${service.id()}`],
        },
      })
      const container = containers[0]
      if (!container) {
        return null
      }

      if (!container.Labels['hammerkit-state']) {
        return null
      }

      return container.Labels['hammerkit-state']
    },
  }
}

async function archiveContainer(
  docker: Dockerode,
  environment: Environment,
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  path: string
) {
  await usingContainer(
    docker,
    item,
    {
      Image: item.data.image,
      Tty: true,
      Entrypoint: 'sh',
      Cmd: ['-c', 'sleep 3600'],
      WorkingDir: convertToPosixPath(item.data.cwd),
      Labels: {
        app: 'hammerkit',
        'hammerkit-id': item.id(),
        'hammerkit-pid': process.pid.toString(),
        'hammerkit-type': 'task',
      },
      HostConfig: {
        AutoRemove: true,
        Binds:
          item.data.type === 'container-service'
            ? item.data.volumes
                .filter((v) => !v.inherited)
                .map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`)
            : item.data.generates
                .filter((v) => !v.inherited && !v.isFile)
                .map((v) => `${v.volumeName}:${convertToPosixPath(v.path)}`),
      },
    },
    async (container) => {
      for (const generatedArchive of getArchivePaths(item.data, path)) {
        const readable = await container.getArchive({
          path: generatedArchive.path,
        })

        await environment.file.writeStream(generatedArchive.filename, readable)
      }
    }
  )
}
