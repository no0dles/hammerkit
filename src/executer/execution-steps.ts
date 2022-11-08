import { ContainerWorkNode, isContainerWorkNode, WorkNode } from '../planner/work-node'
import { pull } from '../docker/pull'
import { Environment } from './environment'
import { ensureVolumeExists, recreateVolume } from './get-docker-executor'
import { ContainerWorkService, isContainerWorkService, WorkService } from '../planner/work-service'
import { extname } from 'path'
import { setUserPermission } from './set-user-permission'
import { Container } from 'dockerode'

export async function pullImage(node: WorkNode | WorkService, environment: Environment): Promise<void> {
  if (isContainerWorkNode(node)) {
    await pull(environment.status.task(node), environment, node.image)
  } else if (isContainerWorkService(node)) {
    await pull(environment.status.service(node), environment, node.image)
  }
}

export async function prepareVolume(node: WorkNode | WorkService, environment: Environment): Promise<void> {
  if (isContainerWorkNode(node) || isContainerWorkService(node)) {
    for (const volume of node.volumes) {
      if (volume.resetOnChange && !volume.inherited) {
        environment.status.from(node).write('debug', 'recreate volume')
        await recreateVolume(environment, volume.name)
      } else {
        environment.status.from(node).write('debug', 'ensure volume exists')
        await ensureVolumeExists(environment, volume.name)
      }
    }
  }
}

export async function prepareMounts(
  node: ContainerWorkNode | ContainerWorkService,
  environment: Environment
): Promise<void> {
  for (const mount of node.mounts) {
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
}

export async function setUserPermissions(
  node: ContainerWorkNode,
  container: Container,
  environment: Environment
): Promise<void> {
  const status = environment.status.from(node)

  if (node.user) {
    if (isContainerWorkNode(node)) {
      await setUserPermission(node.cwd, status, environment, container, node.user)
    }

    for (const volume of node.volumes) {
      await setUserPermission(volume.containerPath, status, environment, container, node.user)
    }
    for (const mount of node.mounts) {
      await setUserPermission(mount.containerPath, status, environment, container, node.user)
    }
  }
}
