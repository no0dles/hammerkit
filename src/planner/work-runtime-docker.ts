import { ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { getRunLabels } from '../docker/run-labels'
import { clearContainerDirectory, convertToPosixPath, getContainerCli } from '../executer/execute-docker'
import { ContainerWorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'
import { ContainerWorkTask, WorkTaskGenerate } from './work-task'
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
import { basename, dirname } from 'path'
import { create, extract } from 'tar'
import { getVolumeName } from './utils/plan-work-volume'
import { WorkDockerEnvironment } from './work-environment'
import { getWorkInstanceId } from './work-instance-id'
import { Readable } from 'stream'
import { getServiceDefinitionHash } from './service-definition'
import { readContainerTaskState, removeContainerTaskState } from '../executer/container-task-state'

export function dockerTaskRuntime(
  task: WorkItem<ContainerWorkTask>,
  workEnvironment: WorkDockerEnvironment
): WorkRuntime<TaskState> {
  const docker = getContainerCli(workEnvironment)
  return {
    async initialize(state: State<TaskState>): Promise<void> {
      const currentTasks = await docker.listContainers({
        filters: {
          label: [`hammerkit-id=${getWorkInstanceId(task)}`],
        },
      })
      // a paused container is a state record of hammerkit before 1.9, not a run
      const currentTask = currentTasks.find((c) => c.State === 'running')
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
          label: [`hammerkit-id=${getWorkInstanceId(task)}`],
        },
      })
      for (const container of containers) {
        await removeContainer(docker.getContainer(container.Id))
      }
    },
    async execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      await dockerTask(docker, task, environment, options)
    },
    async remove(environment: Environment): Promise<void> {
      await this.stop()
      await removeContainerTaskState(environment, task)

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
    async currentStateKey(environment: Environment): Promise<string | null> {
      const stateKey = await readContainerTaskState(environment, task)
      if (!stateKey) {
        return null
      }

      // outputs removed since the run (a deleted export, a pruned volume)
      // leave nothing to reuse
      for (const generate of task.data.generates.filter((g) => !g.inherited)) {
        const present = isOnHost(generate)
          ? await environment.file.exists(generate.path)
          : !!(await existsVolume(docker, generate.volumeName))
        if (!present) {
          return null
        }
      }

      return stateKey
    },
  }
}

// File outputs are bind mounts of host files and exported directories are
// copied to the host, so both must be present on the host, not only in a volume.
function isOnHost(generate: WorkTaskGenerate): boolean {
  return generate.isFile || generate.export
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
      abortSignal: environment.abortCtrl.signal,
      Image: item.data.image,
      Tty: true,
      Entrypoint: ['sh'],
      Cmd: ['-c', 'sleep 3600'],
      WorkingDir: convertToPosixPath(item.data.cwd),
      Labels: {
        app: 'hammerkit',
        'hammerkit-id': getWorkInstanceId(item),
        ...getRunLabels(),
        'hammerkit-type': 'task',
      },
      HostConfig: {
        AutoRemove: true,
        // mount the same volumes archiveContainer reads from, so the restored
        // archives land in the task's output volumes rather than in this
        // throwaway container's filesystem
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
      for (const generate of getArchivePaths(item.data, path)) {
        if (await environment.file.exists(generate.filename)) {
          // a cache hit means exactly the stored outputs: whatever a failed or
          // older run left in the volume goes first
          await clearContainerDirectory(item.status, environment, container, generate.path)
          await container.putArchive(environment.file.readStream(generate.filename), {
            path: dirname(generate.path),
          })
        }
      }
    }
  )

  if (item.data.type === 'container-task') {
    const onHost = new Set(item.data.generates.filter((g) => !g.inherited && isOnHost(g)).map((g) => g.path))
    for (const generate of getArchivePaths(item.data, path)) {
      if (onHost.has(generate.path) && (await environment.file.exists(generate.filename))) {
        await environment.file.remove(generate.path)
        await extract({ file: generate.filename, cwd: dirname(generate.path) })
      }
    }
  }
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
          label: [`hammerkit-id=${getWorkInstanceId(service)}`],
        },
      })
      const currentService = currentServices[0]
      if (!currentService) {
        return
      }

      if (currentService.Labels['hammerkit-definition'] !== getServiceDefinitionHash(service)) {
        service.status.write('info', `${service.name} changed since it was started, recreating it`)
        await removeContainer(docker.getContainer(currentService.Id))
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
          label: [`hammerkit-id=${getWorkInstanceId(service)}`],
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
          label: [`hammerkit-id=${getWorkInstanceId(service)}`],
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
      abortSignal: environment.abortCtrl.signal,
      Image: item.data.image,
      Tty: true,
      Entrypoint: ['sh'],
      Cmd: ['-c', 'sleep 3600'],
      WorkingDir: convertToPosixPath(item.data.cwd),
      Labels: {
        app: 'hammerkit',
        'hammerkit-id': getWorkInstanceId(item),
        ...getRunLabels(),
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
      const hostFiles = new Set(
        item.data.type === 'container-task'
          ? item.data.generates.filter((g) => !g.inherited && g.isFile).map((g) => g.path)
          : []
      )
      for (const generatedArchive of getArchivePaths(item.data, path)) {
        // a file output is a bind mount of a host file, so archive it from the host
        const readable = hostFiles.has(generatedArchive.path)
          ? Readable.from(create({ cwd: dirname(generatedArchive.path) }, [basename(generatedArchive.path)]))
          : await container.getArchive({
              path: generatedArchive.path,
            })

        await environment.file.writeStream(generatedArchive.filename, readable)
      }
    }
  )
}
