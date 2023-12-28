import { ContainerWorkService, WorkService } from '../planner/work-service'
import { dirname, relative } from 'path'
import { V1Volume } from '@kubernetes/client-node/dist/gen/model/v1Volume'
import { V1VolumeMount } from '@kubernetes/client-node/dist/gen/model/v1VolumeMount'
import { ContainerWorkTask, isContainerWorkTask, WorkTask } from '../planner/work-task'
import { V1Container } from '@kubernetes/client-node'
import { WorkItem } from '../planner/work-item'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { getResourceName, removeInvalidCharacters } from './resources'

export interface KubernetesServiceVolume {
  volume: V1Volume
  volumeMount: V1VolumeMount[]
  localPaths: string[]
  containerPath: string
  name: string
}

export interface KubernetesPersistence {
  configMaps: KubernetesConfigMapPersistence[]
  volumes: KubernetesVolumePersistence[]
}

export interface KubernetesVolumePersistence {
  claimName: string
  cwd: string
  volume: V1Volume
  volumeMounts: V1VolumeMount[]
  sources: KubernetesPersistenceSource[]
}

export interface KubernetesPersistenceSource {
  localPath: string
  localCwd: string
  containerPath: string
  stateKey: string
  matcher: (fileName: string, cwd: string) => boolean
}

export interface KubernetesConfigMapPersistence {
  name: string
  volume: V1Volume
  volumeMounts: V1VolumeMount[]
  sources: { localPath: string; subPath: string }[]
}

export function getVolumeName(service: WorkService | ContainerWorkTask, containerPath: string) {
  const name = removeInvalidCharacters(containerPath.replace(/\//g, '-')).toLowerCase()
  if (name.length > 1) {
    return 'hammerkit' + name
  } else {
    return 'hammerkit-root'
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
    volumeMounts: volumes.reduce<V1VolumeMount[]>((mounts, volume) => [...mounts, ...volume.volumeMount], []),
  }))
}

export function getVolumeMounts(persistence: KubernetesPersistence): V1VolumeMount[] {
  return [
    ...persistence.volumes.reduce<V1VolumeMount[]>((mounts, volume) => [...mounts, ...volume.volumeMounts], []),
    ...persistence.configMaps.reduce<V1VolumeMount[]>((mounts, volume) => [...mounts, ...volume.volumeMounts], []),
  ]
}

export function getVolumes(persistence: KubernetesPersistence): V1Volume[] {
  return [...persistence.volumes.map((v) => v.volume), ...persistence.configMaps.map((c) => c.volume)]
}

export async function getKubernetesPersistence(
  work: WorkItem<ContainerWorkTask | ContainerWorkService>
): Promise<KubernetesPersistence> {
  const persistence: KubernetesPersistence = { configMaps: [], volumes: [] }

  for (const mount of work.data.mounts) {
    appendVolume(work.data, persistence, mount.containerPath, mount.localPath, mount.isFile)
  }

  for (const src of work.data.src) {
    appendVolume(work.data, persistence, src.absolutePath, src.absolutePath, src.isFile) // TODO matcher
  }

  if (work.data.type === 'container-task') {
    for (const generate of work.data.generates) {
      appendVolume(work.data, persistence, generate.path, generate.path, generate.isFile)
    }
  }

  for (const volume of work.data.volumes) {
    appendVolume(work.data, persistence, volume.containerPath, null, false)
  }

  return persistence
}

export function appendVolume(
  work: ContainerWorkService | ContainerWorkTask,
  persistence: KubernetesPersistence,
  containerPath: string,
  localPath: string | null,
  isFile: boolean
): void {
  const workResourceName = getResourceName(work)

  // if (isFile) {
  //   if (!localPath) {
  //     return
  //   }
  //   const configMapName = `${workResourceName}-files`
  //   let configMap = persistence.configMaps[0]
  //
  //   if (!configMap) {
  //     configMap = {
  //       name: configMapName,
  //       volume: { name: configMapName, configMap: { name: configMapName } },
  //       volumeMounts: [],
  //       sources: [],
  //     }
  //     persistence.configMaps.push(configMap)
  //   }
  //   const subPath = relative(work.cwd, containerPath)
  //   configMap.sources.push({ subPath, localPath })
  //   configMap.volumeMounts.push({
  //     name: configMapName,
  //     mountPath: dirname(containerPath),
  //     subPath,
  //   })
  // } else {
  const sourceDir = isFile ? dirname(containerPath) : containerPath
  const cwd = relative(work.cwd, sourceDir).startsWith('..') ? sourceDir : work.cwd

  const volumeName = getVolumeName(work, cwd)
  let volume = persistence.volumes.find((v) => v.cwd === cwd)
  if (!volume) {
    volume = {
      claimName: volumeName,
      volume: {
        name: volumeName,
        persistentVolumeClaim: {
          claimName: volumeName,
        },
      },
      cwd,
      volumeMounts: [
        {
          name: volumeName,
          mountPath: cwd,
        },
      ],
      sources: [],
    }
    persistence.volumes.push(volume)
  }
  if (localPath) {
    volume.sources.push({
      localCwd: dirname(localPath),
      localPath: localPath,
      matcher: () => true, // TODO
      containerPath,
      stateKey: '', // TODO
    })
  }
  //}
}
