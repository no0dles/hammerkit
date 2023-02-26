import { ContainerWorkService, WorkService } from '../planner/work-service'
import { dirname } from 'path'
import { V1Volume } from '@kubernetes/client-node/dist/gen/model/v1Volume'
import { V1VolumeMount } from '@kubernetes/client-node/dist/gen/model/v1VolumeMount'
import { isContainerWorkTask, WorkTask } from '../planner/work-task'
import { V1Container } from '@kubernetes/client-node'
import { WorkItem } from '../planner/work-item'
import { getEnvironmentVariables } from '../environment/replace-env-variables'

export interface KubernetesServiceVolume {
  volume: V1Volume
  volumeMount: V1VolumeMount
  localPaths: string[]
  containerPath: string
  name: string
}

export function getVolumeName(service: WorkService, containerPath: string) {
  const mountPath = dirname(containerPath)
  const name = mountPath.replace(/\//g, '-').toLowerCase()
  if (name.length > 1) {
    return service.name.replace(/:/, '-') + name
  } else {
    return service.name.replace(/:/, '-') + '-root'
  }
}

export function getContainer(task: WorkTask, volumes: KubernetesServiceVolume[]): V1Container[] {
  if (!isContainerWorkTask(task)) {
    throw new Error('not supported local task')
  }

  const envs = getEnvironmentVariables(task.envs)
  return task.cmds.map<V1Container>((cmd, index) => ({
    name: task.name.replace(/:/, '-') + '-' + index,
    env: Object.entries(envs).map(([key, value]) => ({
      name: key,
      value,
    })),
    image: task.image,
    command: [cmd.parsed.command],
    args: cmd.parsed.args,
    workingDir: cmd.cwd,
    volumeMounts: volumes.map((v) => v.volumeMount),
  }))
}

function appendVolume(
  service: ContainerWorkService,
  volumes: { [key: string]: KubernetesServiceVolume },
  containerPath: string
): KubernetesServiceVolume {
  const name = getVolumeName(service, containerPath)
  const containerDirectory = dirname(containerPath)
  if (!volumes[name]) {
    volumes[name] = {
      name,
      localPaths: [],
      containerPath: containerDirectory,
      volumeMount: {
        name,
        mountPath: containerDirectory,
      },
      volume: {
        name,
        persistentVolumeClaim: {
          claimName: name,
        },
      },
    }
  }
  return volumes[name]
}

export function getServiceVolumes(service: WorkItem<ContainerWorkService>): KubernetesServiceVolume[] {
  const volumes: { [key: string]: KubernetesServiceVolume } = {}
  for (const mount of service.data.mounts) {
    const volume = appendVolume(service.data, volumes, mount.containerPath)
    if (volume.localPaths.indexOf(mount.localPath) === -1) {
      volume.localPaths.push(mount.localPath)
    }
  }

  // for (const src of service.src) {
  //   appendVolume(service, volumes, src.relativePath)
  // }

  for (const volume of service.data.volumes) {
    appendVolume(service.data, volumes, volume.containerPath)
  }

  // TODO check if needed, dep mounts should be inherited
  for (const dep of service.deps) {
    if (isContainerWorkTask(dep.data)) {
      for (const mount of dep.data.mounts) {
        const volume = appendVolume(service.data, volumes, mount.containerPath)
        if (volume.localPaths.indexOf(mount.localPath) === -1) {
          volume.localPaths.push(mount.localPath)
        }
      }
    }
  }
  return Object.values(volumes)
}
