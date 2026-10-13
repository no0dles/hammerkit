import { ContainerWorkService, WorkService } from '../planner/work-service'
import { basename, dirname, isAbsolute, relative, sep } from 'path'
import { existsSync } from 'fs'
import { V1Affinity, V1Volume, V1VolumeMount } from '@kubernetes/client-node'
import { WorkKubernetesEnvironment, WorkKubernetesWorkspace } from '../planner/work-environment'
import { ContainerWorkTask, WorkTask } from '../planner/work-task'
import { WorkItem } from '../planner/work-item'

export interface KubernetesPersistence {
  // the claims of the work and of what it inherits
  volumes: V1Volume[]
  // the claim of a sandbox the run works on, which is not the run's
  workspace: V1Volume[]
  // `workspace` for a mount of the sandbox's claim: nothing is uploaded to it, and only
  // the pods of the work itself mount it
  mounts: { mount: V1VolumeMount; cwd: string; uploadPath: string; workspace?: true }[]
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

const WORKSPACE_VOLUME = 'hammerkit-sandbox'

// The path of `path` below the root of a sandbox's files, or undefined when it is not
// below it
function workspacePath(workspace: WorkKubernetesWorkspace, path: string): string | undefined {
  const rel = relative(workspace.root, path)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return undefined
  }
  return [workspace.subPath, ...rel.split(sep).filter((part) => part.length > 0)].join('/')
}

// A path of a sandbox is mounted from its claim, read and write as on a host's docker,
// so what the task writes is in the sandbox afterwards. A path that is not in the
// sandbox is left out: Kubernetes would make a directory of it in the claim.
function appendWorkspaceMount(
  workspace: WorkKubernetesWorkspace,
  persistence: KubernetesPersistence,
  containerPath: string,
  localPath: string,
  isFile: boolean,
  readOnly: boolean
): boolean {
  const subPath = workspacePath(workspace, localPath)
  if (subPath === undefined) {
    return false
  }
  if (!existsSync(localPath)) {
    return true
  }
  if (persistence.workspace.length === 0) {
    persistence.workspace.push({ name: WORKSPACE_VOLUME, persistentVolumeClaim: { claimName: workspace.claim } })
  }
  persistence.mounts.push({
    mount: { readOnly, mountPath: containerPath, name: WORKSPACE_VOLUME, subPath },
    uploadPath: '',
    cwd: isFile ? dirname(containerPath) : containerPath,
    workspace: true,
  })
  return true
}

export async function getKubernetesPersistence(
  work: WorkItem<ContainerWorkTask | ContainerWorkService>,
  kubernetes?: Pick<WorkKubernetesEnvironment, 'server'>
): Promise<KubernetesPersistence> {
  const persistence: KubernetesPersistence = { volumes: [], workspace: [], sources: [], mounts: [], initCommands: [] }
  const workspace = kubernetes?.server?.workspace

  for (const mount of work.data.mounts) {
    if (
      workspace &&
      appendWorkspaceMount(workspace, persistence, mount.containerPath, mount.localPath, mount.isFile, mount.readOnly)
    ) {
      continue
    }
    appendVolume(work, persistence, mount.containerPath, mount.localPath, mount.isFile, true)
  }

  for (const src of work.data.src) {
    if (src.inherited) {
      continue
    }
    if (
      workspace &&
      appendWorkspaceMount(workspace, persistence, src.absolutePath, src.absolutePath, src.isFile, false)
    ) {
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
      appendVolume(
        volume.inherited ?? work,
        persistence,
        volume.containerPath,
        null,
        false,
        !!volume.inherited || volume.readOnly
      )
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

/**
 * What a pod that mounts the claim of a sandbox needs: its label, and to go where the
 * other pods that mount it run. A claim is usually `ReadWriteOnce`, which several pods
 * share only on one node; the first pod (no other one runs) goes anywhere.
 */
export function getWorkspacePodSpec(
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>,
  persistence: Pick<KubernetesPersistence, 'workspace'>
): { labels: { [label: string]: string }; affinity?: V1Affinity } {
  const workspace = kubernetes.server?.workspace
  if (!workspace || persistence.workspace.length === 0) {
    return { labels: {} }
  }
  return {
    labels: { [SANDBOX_LABEL]: workspace.label },
    affinity: getSandboxAffinity(workspace.label),
  }
}

// the label of the pods that mount the claim of a sandbox
export const SANDBOX_LABEL = 'hammerkit.dev/sandbox'

export function getSandboxAffinity(label: string): V1Affinity {
  return {
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        { labelSelector: { matchLabels: { [SANDBOX_LABEL]: label } }, topologyKey: 'kubernetes.io/hostname' },
      ],
    },
  }
}
