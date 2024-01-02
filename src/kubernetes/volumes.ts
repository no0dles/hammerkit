import { ContainerWorkService, WorkService } from '../planner/work-service'
import { basename, dirname } from 'path'
import { V1Volume } from '@kubernetes/client-node/dist/gen/model/v1Volume'
import { V1VolumeMount } from '@kubernetes/client-node/dist/gen/model/v1VolumeMount'
import { ContainerWorkTask, WorkTask } from '../planner/work-task'
import { WorkItem } from '../planner/work-item'

export interface KubernetesPersistence {
  volumes: V1Volume[]
  mounts: { mount: V1VolumeMount; cwd: string; uploadPath: string }[]
  sources: KubernetesPersistenceSource[]
  initCommands: string[]
}

export interface KubernetesPersistenceSource {
  localPath: string
  containerPath: string
  stateKey: string
  matcher: (fileName: string, cwd: string) => boolean
}

export function getVolumeName(service: WorkItem<WorkService | WorkTask>) {
  return 'hammerkit-' + service.id()
}

export async function getKubernetesPersistence(
  work: WorkItem<ContainerWorkTask | ContainerWorkService>
): Promise<KubernetesPersistence> {
  const persistence: KubernetesPersistence = { volumes: [], sources: [], mounts: [], initCommands: [] }

  for (const mount of work.data.mounts) {
    appendVolume(work, persistence, mount.containerPath, mount.localPath, mount.isFile, true)
  }

  for (const src of work.data.src) {
    if (src.inherited) {
      continue
    }
    appendVolume(work, persistence, src.absolutePath, src.absolutePath, src.isFile, true) // TODO matcher
  }

  if (work.data.type === 'container-task') {
    for (const generate of work.data.generates) {
      appendVolume(generate.inherited ?? work, persistence, generate.path, null, false, !!generate.inherited)
    }
  } else {
    for (const volume of work.data.volumes) {
      appendVolume(volume.inherited ?? work, persistence, volume.containerPath, null, false, !!volume.inherited)
    }
  }

  return persistence
}

export function appendVolume(
  sourceWork: WorkItem<WorkTask | WorkService>,
  persistence: KubernetesPersistence,
  containerPath: string,
  localPath: string | null,
  isFile: boolean,
  readOnly: boolean
): void {
  const volumeName = getVolumeName(sourceWork)

  const existVolume = persistence.volumes.some((v) => v.name === volumeName)
  if (!existVolume) {
    persistence.volumes.push({
      name: volumeName,
      persistentVolumeClaim: {
        claimName: volumeName,
      },
    })
  }

  persistence.mounts.push({
    mount: {
      readOnly,
      mountPath: containerPath,
      name: volumeName,
      subPath: basename(containerPath),
    },
    uploadPath: `/dev/hammerkit/${sourceWork.id()}`,
    cwd: isFile ? dirname(containerPath) : containerPath,
  })

  if (localPath) {
    persistence.sources.push({
      localPath: localPath,
      matcher: () => true, // TODO
      containerPath,
      stateKey: '', // TODO
    })
  }
}
