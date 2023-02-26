import { pull } from '../docker/pull'
import { Environment } from './environment'
import { ensureVolumeExists, recreateVolume } from './get-docker-executor'
import { extname } from 'path'
import { setUserPermission } from './set-user-permission'
import { Container } from 'dockerode'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask, isContainerWorkTask } from '../planner/work-task'
import { ContainerWorkService } from '../planner/work-service'
import { getContainerBinds } from './get-container-binds'

export async function pullImage(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  environment: Environment
): Promise<void> {
  await pull(item.status, environment, item.data.image)
}

export async function prepareVolume(
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  environment: Environment
): Promise<void> {
  for (const volume of item.data.volumes) {
    if (volume.resetOnChange && !volume.inherited) {
      item.status.write('debug', 'recreate volume')
      await recreateVolume(environment, item.status, volume.name)
    } else {
      item.status.write('debug', 'ensure volume exists')
      await ensureVolumeExists(environment, item.status, volume.name)
    }
  }
  if (isContainerWorkTask(item.data)) {
    for (const generate of item.data.generates) {
      if (generate.isFile) {
        continue
      }
      if (generate.resetOnChange && !generate.inherited) {
        item.status.write('debug', 'recreate volume')
        await recreateVolume(environment, item.status, generate.volumeName)
      } else {
        item.status.write('debug', 'ensure volume exists')
        await ensureVolumeExists(environment, item.status, generate.volumeName)
      }
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
      await environment.file.writeFile(mount.localPath, '')
    } else {
      await environment.file.createDirectory(mount.localPath)
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
    const binds = getContainerBinds(item)

    await setUserPermission(item.data.cwd, item.status, environment, container, item.data.user)

    for (const bind of binds) {
      await setUserPermission(bind.containerPath, item.status, environment, container, item.data.user)
    }
  }
}
