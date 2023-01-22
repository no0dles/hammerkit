import { ContainerWorkService, WorkService } from '../../planner/work-service'
import { dirname } from 'path'
import { V1Volume } from '@kubernetes/client-node/dist/gen/model/v1Volume'
import { V1VolumeMount } from '@kubernetes/client-node/dist/gen/model/v1VolumeMount'
import { isContainerWorkNode, WorkNode } from '../../planner/work-node'
import { V1Container } from '@kubernetes/client-node'

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

export function getContainer(node: WorkNode, volumes: KubernetesServiceVolume[]): V1Container[] {
  if (!isContainerWorkNode(node)) {
    throw new Error('not supported local node')
  }

  return node.cmds.map<V1Container>((cmd, index) => ({
    name: node.name.replace(/:/, '-') + '-' + index,
    env: Object.keys(node.envs).map((key) => ({
      name: key,
      value: node.envs[key],
    })),
    image: node.image,
    command: [cmd.cmd.split(' ')[0]],
    args: cmd.cmd.split(' ').slice(1),
    workingDir: cmd.path,
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

export function getServiceVolumes(service: ContainerWorkService): KubernetesServiceVolume[] {
  const volumes: { [key: string]: KubernetesServiceVolume } = {}
  for (const mount of service.mounts) {
    const volume = appendVolume(service, volumes, mount.containerPath)
    if (volume.localPaths.indexOf(mount.localPath) === -1) {
      volume.localPaths.push(mount.localPath)
    }
  }

  // for (const src of service.src) {
  //   appendVolume(service, volumes, src.relativePath)
  // }

  for (const volume of service.volumes) {
    appendVolume(service, volumes, volume.containerPath)
  }

  for (const dep of service.deps) {
    if (isContainerWorkNode(dep)) {
      for (const mount of dep.mounts) {
        const volume = appendVolume(service, volumes, mount.containerPath)
        if (volume.localPaths.indexOf(mount.localPath) === -1) {
          volume.localPaths.push(mount.localPath)
        }
      }
    }
  }
  return Object.values(volumes)
}
