import { pull } from '../docker/pull'
import { Environment } from './environment'
import { ensureVolumeExists, recreateVolume, volumeLabels } from './get-docker-executor'
import { extname, isAbsolute } from 'path'
import { setUserPermission } from './set-user-permission'
import Dockerode, { Container } from 'dockerode'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask, isContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService, isContainerWorkService } from '../planner/work-service'
import { getContainerBinds } from './get-container-binds'
import { assertItemPathsWithinRoot } from '../planner/utils/assert-item-paths'
import { getErrorMessage } from '../log'

// The files a server run works on: its checkout, or a sandbox. Somebody else wrote them.
export function hostedRoot(environment: Environment): string | undefined {
  return environment.hosted ? environment.cwd : undefined
}

/**
 * On a server, every path of the host an item binds into its container, or the engine
 * reads or writes for it, has to stay inside the run's files with no link on the way:
 * tasks of this or an earlier run on a sandbox, or the commit of a ref, could have left
 * one pointing anywhere on the server. The runtime checks before an item runs; this is
 * checked again right before a container is made and before outputs are copied, after
 * other tasks of the run had their turn.
 */
export async function refuseHostLinks(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  environment: Environment
): Promise<void> {
  const root = hostedRoot(environment)
  if (root) {
    await assertItemPathsWithinRoot(item, root)
  }
}

export async function pullImage(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  docker: Dockerode,
  environment: Environment
): Promise<void> {
  await pull(item.status, docker, item.data.image, environment)
}

export async function prepareVolume(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  docker: Dockerode,
  environment?: Environment
): Promise<void> {
  const labels = volumeLabels(environment ? hostedRoot(environment) : undefined)
  if (isContainerWorkService(item.data)) {
    for (const volume of item.data.volumes) {
      if (volume.resetOnChange && !volume.inherited) {
        item.status.write('debug', 'recreate volume')
        await recreateVolume(docker, item.status, volume.name, labels)
      } else {
        item.status.write('debug', 'ensure volume exists')
        await ensureVolumeExists(docker, item.status, volume.name, labels)
      }
    }
  }
  if (isContainerWorkTask(item.data)) {
    // a task's outputs are emptied inside its container (see dockerTask)
    for (const generate of item.data.generates) {
      if (generate.isFile) {
        continue
      }
      item.status.write('debug', 'ensure volume exists')
      await ensureVolumeExists(docker, item.status, generate.volumeName, labels)
    }
  }
}

export async function prepareMounts(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  environment: Environment
): Promise<void> {
  for (const mount of item.data.mounts) {
    const exists = await environment.file.exists(mount.localPath)

    if (exists) {
      continue
    }

    if (extname(mount.localPath)) {
      try {
        await environment.file.writeFile(mount.localPath, '')
      } catch (e) {
        // Docker would make a directory there
        throw new Error(`mount ${mount.localPath} does not exist and can't be created (${getErrorMessage(e)})`)
      }
    } else {
      try {
        await environment.file.createDirectory(mount.localPath)
      } catch (e) {
        // on a server a root-owned directory in the run's files could break its cleanup
        if (environment.hosted) {
          throw e
        }
        // hammerkit may run in a container whose file system is not the one of the Docker
        // host: Docker creates the missing directory of a bind on its own
        item.status.write(
          'warn',
          `can't create ${mount.localPath} (${getErrorMessage(e)}), Docker creates it on its host as root`
        )
      }
    }
  }
  if (isContainerWorkTask(item.data)) {
    for (const gen of item.data.generates) {
      if (!gen.isFile) {
        continue
      }
      const exists = await environment.file.exists(gen.path)
      if (exists) {
        continue
      }

      await environment.file.writeFile(gen.path, '')
    }
  }
}

export async function setUserPermissions(
  item: WorkItem<ContainerWorkTask>,
  container: Container,
  environment: Environment
): Promise<void> {
  if (item.data.user) {
    // On a server only the volumes: a chown as the container's root on a path of the host
    // would follow a link a task put there after the binds were checked. Never a mount: it
    // is a path of the host the build file names, such as /var/run/docker.sock, whose owner
    // is not hammerkit's to change
    const mounted = new Set(item.data.mounts.map((mount) => mount.containerPath))
    const binds = getContainerBinds(item).filter(
      (bind) => !mounted.has(bind.containerPath) && (!environment.hosted || !isAbsolute(bind.localPath))
    )

    if (!environment.hosted) {
      await setUserPermission(item.data.cwd, item.status, environment, container, item.data.user)
    }

    for (const bind of binds) {
      await setUserPermission(bind.containerPath, item.status, environment, container, item.data.user)
    }
  }
}
