import { ContainerWorkService, WorkService } from '../planner/work-service'
import { dirname, isAbsolute, relative, sep } from 'path'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { V1Affinity, V1Volume, V1VolumeMount } from '@kubernetes/client-node'
import { WorkKubernetesEnvironment, WorkKubernetesWorkspace } from '../planner/work-environment'
import { ContainerWorkTask, WorkTask } from '../planner/work-task'
import { WorkItem, WorkItemState } from '../planner/work-item'
import { getClaimName, isKeptClaim } from './kept-claims'
import { getClaimSubPath } from './claim-layout'

export interface KubernetesPersistence {
  // the claims of the work and of what it inherits
  volumes: V1Volume[]
  // the `volumeSize` of the work each claim of `volumes` belongs to, null for the
  // environment's
  sizes: { [claim: string]: string | null }
  // the claims of `volumes` that stay after the run (see isKeptClaim)
  kept: string[]
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
  // where it goes in the claim, relative to its root (see getClaimSubPath)
  subPath: string
  stateKey: string
  matcher: (fileName: string, cwd: string) => boolean
}

export function getVolumeName(
  service: WorkItem<WorkService | WorkTask>,
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>
) {
  return getClaimName(service, kubernetes)
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
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>,
  // the state the work runs at, on a service run (see getStateFilesDir); what it inherits is
  // at the state its own work item completed at
  stateKey?: string
): Promise<KubernetesPersistence> {
  const dirOf = (item: WorkItem<WorkTask | WorkService>) =>
    kubernetes.server?.serviceRun ? getItemFilesDir(item, item === work ? stateKey : undefined) : undefined
  const own = dirOf(work)
  // a service that watches its files mounts them from the folder they are synced into, and
  // takes them into the folder of their state (see syncLiveFiles)
  const mounted = own && isLiveService(work, kubernetes) ? LIVE_FILES_DIR : own
  const persistence: KubernetesPersistence = {
    volumes: [],
    sizes: {},
    kept: [],
    workspace: [],
    sources: [],
    mounts: [],
    initCommands: [],
  }
  const workspace = kubernetes.server?.workspace

  for (const mount of work.data.mounts) {
    if (
      workspace &&
      appendWorkspaceMount(workspace, persistence, mount.containerPath, mount.localPath, mount.isFile, mount.readOnly)
    ) {
      continue
    }
    appendVolume(work, persistence, mount.containerPath, mount.localPath, mount.isFile, true, kubernetes, mounted, own)
  }

  // its deps' src too, uploaded into its own claim: a container task sees them as it does on
  // docker (a tsc -b of a project that references another reads the other's tsconfig)
  for (const src of work.data.src) {
    if (
      workspace &&
      appendWorkspaceMount(workspace, persistence, src.absolutePath, src.absolutePath, src.isFile, false)
    ) {
      continue
    }
    appendVolume(work, persistence, src.absolutePath, src.absolutePath, src.isFile, true, kubernetes, mounted, own) // TODO matcher
  }

  if (work.data.type === 'container-task') {
    for (const generate of work.data.generates) {
      appendVolume(
        generate.inherited ?? work,
        persistence,
        generate.path,
        null,
        false,
        !!generate.inherited,
        kubernetes,
        dirOf(generate.inherited ?? work)
      )
    }
  } else {
    for (const volume of work.data.volumes) {
      appendVolume(
        volume.inherited ?? work,
        persistence,
        volume.containerPath,
        null,
        false,
        !!volume.inherited || volume.readOnly,
        kubernetes,
        // the data of a service stays where it is, the outputs of its deps are by their state
        volume.inherited ? dirOf(volume.inherited) : undefined
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
  readOnly: boolean,
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>,
  // the folder of the state of `sourceWork` the path is in, see getStateFilesDir
  stateDir?: string,
  // the folder its upload goes to, when it is not the one the path is mounted from (a
  // service that watches its files, see syncLiveFiles)
  uploadDir: string | undefined = stateDir
): void {
  const volumeName = getVolumeName(sourceWork, kubernetes)
  const claimPath = getClaimSubPath(sourceWork, containerPath)
  const subPath = (stateDir ? `${stateDir}/` : '') + claimPath

  const existVolume = persistence.volumes.some((v) => v.name === volumeName)
  if (!existVolume) {
    persistence.volumes.push({
      name: volumeName,
      persistentVolumeClaim: {
        claimName: volumeName,
      },
    })
    persistence.sizes[volumeName] = 'volumeSize' in sourceWork.data ? sourceWork.data.volumeSize : null
    if (isKeptClaim(sourceWork, kubernetes)) {
      persistence.kept.push(volumeName)
    }
  }

  persistence.mounts.push({
    mount: {
      readOnly,
      mountPath: containerPath,
      name: volumeName,
      subPath,
    },
    uploadPath: `/dev/hammerkit/${sourceWork.id()}`,
    cwd: isFile ? dirname(containerPath) : containerPath,
  })

  if (localPath) {
    persistence.sources.push({
      localPath: localPath,
      matcher: () => true, // TODO
      containerPath,
      subPath: (uploadDir ? `${uploadDir}/` : '') + claimPath,
      stateKey: '', // TODO
    })
  }
}

/**
 * What a pod that mounts the claim of a sandbox needs: its label, and to go where the
 * other pods that mount it run. A claim is usually `ReadWriteOnce`, which several pods
 * share only on one node; the first pod (no other one runs) goes anywhere. The pod of the
 * sandbox's files runs on the first pool while a run works, so a task on another pool
 * would never start: it is refused.
 */
export function getWorkspacePodSpec(
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>,
  persistence: Pick<KubernetesPersistence, 'workspace'> & Partial<Pick<KubernetesPersistence, 'volumes'>>,
  task?: { name: string; pool?: string }
): { labels: { [label: string]: string }; affinity?: V1Affinity } {
  const workspace = kubernetes.server?.workspace
  if (kubernetes.server?.serviceRun && !workspace) {
    return getClaimPodSpec(persistence.volumes ?? [])
  }
  if (!workspace || persistence.workspace.length === 0) {
    return { labels: {} }
  }
  const first = kubernetes.server?.pools[0]?.name
  if (task?.pool && first && task.pool !== first) {
    throw new Error(
      `task ${task.name}: runs on the pool ${task.pool}, and the tasks of a run on a sandbox run on the first pool, ${first}, where its files are`
    )
  }
  return {
    labels: { [SANDBOX_LABEL]: workspace.label },
    affinity: getSandboxAffinity(workspace.label),
  }
}

/**
 * A pod of a service run that mounts claims: labelled by each of them, and made to go where a
 * pod runs that mounts all of them. A run that moves to another commit starts a new pod of a
 * service, a Job of a changed task or an upload while the pods of the commit before still
 * mount the same claims, which a cloud disk attaches to one node at a time: a pod on another
 * node would wait for the disk until its deadline. Required, as one term: while no pod mounts
 * all of them (the first one, or after the run slept), the scheduler lets the pod go anywhere,
 * because it matches the term itself, so a Deployment that keeps the term is never held back
 * by it. Mounting all of them is what holds the disks on one node.
 */
export function getClaimPodSpec(volumes: Pick<V1Volume, 'persistentVolumeClaim'>[]): {
  labels: { [label: string]: string }
  affinity?: V1Affinity
} {
  const keys = [
    ...new Set(
      volumes.flatMap((volume) =>
        volume.persistentVolumeClaim ? [getClaimMountLabel(volume.persistentVolumeClaim.claimName)] : []
      )
    ),
  ].sort()
  if (keys.length === 0) {
    return { labels: {} }
  }
  const labels = Object.fromEntries(keys.map((key) => [key, 'mounted']))
  return {
    labels,
    affinity: {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          { labelSelector: { matchLabels: labels }, topologyKey: 'kubernetes.io/hostname' },
        ],
      },
    },
  }
}

// a claim name is longer than a label name may be: its hash
export function getClaimMountLabel(claimName: string): string {
  return `claim.hammerkit.dev/${createHash('sha256').update(claimName).digest('hex').slice(0, 16)}`
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

// The folder of a service run's claim that holds the files of one state of a work item: the
// src and mounts it uploads, and the outputs of a task. A run that moves to another commit
// uploads and builds the files of the new state into a folder of their own, so the pods of
// the commit before keep the files and outputs they started with until the new ones are up,
// and a Deployment that is put back finds them again. The volumes of a service hold its data,
// which stays where it is.
export const STATE_FILES_PREFIX = '.hammerkit-files-'

export function getStateFilesDir(stateKey: string): string {
  return `${STATE_FILES_PREFIX}${createHash('sha256').update(stateKey).digest('hex').slice(0, 16)}`
}

// The folder of the claim of a service of a service run that watches its own files
// (`continuous`), which its pod mounts its `src` and `mounts` from. The files of each state
// are uploaded into the folder of that state, and synced into this one from there: the pod
// stays, and the service sees the files of the new commit (syncLiveFiles).
export const LIVE_FILES_DIR = `${STATE_FILES_PREFIX}live`

export function isLiveService(
  work: WorkItem<WorkTask | WorkService>,
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>
): work is WorkItem<ContainerWorkService> {
  return (
    !!kubernetes.server?.serviceRun &&
    !kubernetes.server.workspace &&
    work.data.type === 'container-service' &&
    work.data.continuous === true
  )
}

// The folder of the state of `item`: `stateKey`, or the one it completed at in this run
export function getItemFilesDir(
  item: WorkItem<WorkTask | WorkService>,
  stateKey: string | undefined
): string | undefined {
  const key =
    stateKey ??
    (item as Partial<WorkItemState<WorkTask | WorkService, { stateKey?: string | null }>>).state?.current.stateKey
  return key ? getStateFilesDir(key) : undefined
}
