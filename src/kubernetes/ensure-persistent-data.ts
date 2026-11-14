import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import {
  getClaimPodSpec,
  getVolumeName,
  KubernetesPersistence,
  KubernetesPersistenceSource,
  LIVE_FILES_DIR,
  STATE_FILES_PREFIX,
} from './volumes'
import { V1Pod, V1VolumeMount } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { basename, dirname } from 'path'
import { packArchive } from '../utils/tar'
import { KubernetesInstance } from './kubernetes-instance'
import { getItemLabels, getResourceName } from './resources'
import { awaitRunningState } from './await-running-state'
import { sleep } from '../utils/sleep'
import { checkForAbort } from '../executer/abort'
import { getVersion } from '../version'
import { getErrorMessage } from '../log'
import { ContainerWorkTask } from '../planner/work-task'
import { ensureKubernetesPersistentVolumeClaimExists } from './ensure-kubernetes-persistent-volume-claim-exists'
import { Environment } from '../executer/environment'
import { Readable } from 'stream'
import { getContainerSecurity, getPodPlacement, getRunLabels } from './job-placement'
import { assertItemPathsWithinRoot } from '../planner/utils/assert-item-paths'

// A previous run that crashed between creating an upload/download pod and its
// `finally` cleanup leaves a pod behind under the same deterministic name. apply()
// would then patch that stale pod in place — and if it is stuck in a terminal
// phase the subsequent awaitRunningState never resolves. Force-delete any leftover
// and wait for it to disappear before scheduling a fresh one.
async function removeStalePod(instance: KubernetesInstance, namespace: string, name: string): Promise<void> {
  try {
    await instance.coreApi.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return
    }
    throw e
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await instance.coreApi.readNamespacedPod({ name, namespace })
    } catch (e) {
      if (statusCodeOf(e) === 404) {
        return
      }
      throw e
    }
    await sleep(500)
  }
}

// What the pod that copies files into and out of a claim gets: tar and find, through
// exec. Without its own, the default limit of the namespace is taken, which is sized for
// tasks (4Gi on a server), and a run's quota then has no room for the pods of its tasks.
export const TRANSFER_POD_RESOURCES = {
  requests: { cpu: '50m', memory: '64Mi' },
  limits: { memory: '512Mi' },
}

// how long a transfer pod waits for room under the quota of its namespace, such as the
// pods of other tasks of the run ending, before its task fails
export const QUOTA_TIMEOUT = 10 * 60 * 1000

// A Job waits for room under a full quota, a pod is refused: so a transfer pod is
// created again until the pods of the tasks it runs beside are done and make room
export async function applyWithinQuota(
  instance: KubernetesInstance,
  podSpec: V1Pod & KubernetesObjectHeader,
  service: Pick<WorkItem<ContainerWorkService | ContainerWorkTask>, 'status'>,
  timeout = QUOTA_TIMEOUT,
  pollInterval = 2000,
  // a run stopped while it waits: it stops waiting
  signal?: AbortSignal
): Promise<V1Pod> {
  const deadline = Date.now() + timeout
  for (let waiting = false; ; waiting = true) {
    if (signal) {
      checkForAbort(signal)
    }
    try {
      return await apply(instance, podSpec)
    } catch (e) {
      if (statusCodeOf(e) !== 403 || !/exceeded quota/i.test(getErrorMessage(e)) || Date.now() >= deadline) {
        throw e
      }
      if (!waiting) {
        service.status.write('info', `wait for room under the quota of ${podSpec.metadata.namespace}`)
      }
      await sleep(pollInterval)
    }
  }
}

export async function getPodForPersistence(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService | ContainerWorkTask>,
  persistence: KubernetesPersistence,
  type: 'read' | 'write',
  // stops a wait for room under the quota
  signal: AbortSignal | undefined,
  fn: (podName: string) => Promise<void>
) {
  if (persistence.volumes.length === 0) {
    return
  }

  // the claim of a sandbox is mounted by the pods of the work only: it holds no output
  // and takes no upload
  const own = persistence.mounts.filter((m) => !m.workspace)
  const mounts: V1VolumeMount[] =
    type === 'read'
      ? // what a task stores are its outputs, which it mounts writable: its src and the
        // outputs of its deps are not mounted, so an output inside a folder of its src
        // (pkg/coverage/lcov.info) has a place in the pod even when the claim holds no src,
        // after a restore into a new claim
        own.filter((m) => service.data.type !== 'container-task' || !m.mount.readOnly).map((m) => m.mount)
      : own.reduce<V1VolumeMount[]>((array, v) => {
          if (!array.some((i) => i.name === v.mount.name)) {
            array.push({
              mountPath: v.uploadPath,
              name: v.mount.name,
              readOnly: false,
            })
          }
          return array
        }, [])

  // only the claims it mounts: one of a dep it doesn't read would only bind where it goes
  const volumes = persistence.volumes.filter((volume) => mounts.some((mount) => mount.name === volume.name))

  // Guarantee the claims exist right before scheduling the pod that mounts
  // them. ensurePersistentData also creates them, but store/restore reach this
  // function directly, and a claim shared with another work item can be removed
  // concurrently — without this the pod would hang Pending on "pvc not found".
  for (const volume of volumes) {
    await ensureKubernetesPersistentVolumeClaimExists(
      instance,
      env,
      volume,
      service,
      persistence.sizes[volume.name],
      persistence.kept.includes(volume.name)
    )
  }

  const name = getResourceName(service, env, type === 'write' ? '-upload' : '-download')
  // a service of a service run is up while its claim takes an upload (a move to another
  // commit): the pod is not one its Service sends to
  const serving = !!env.server?.serviceRun && service.data.type === 'container-service'
  // and on a service run, it goes where the pods that mount the same claims run
  const claims = env.server?.serviceRun ? getClaimPodSpec(volumes) : { labels: {} }
  const podSpec: V1Pod & KubernetesObjectHeader = {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      labels: { ...(serving ? getRunLabels(env) : getItemLabels(service, env)), ...claims.labels },
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
      ...(claims.affinity ? { affinity: claims.affinity } : {}),
      // on a server the claims are bound where the pod of the task can go: the nodes
      // of its pool
      ...(env.server
        ? {
            automountServiceAccountToken: false,
            ...getPodPlacement(env.server, 'pool' in service.data ? service.data.pool : undefined),
          }
        : {}),
      containers: [
        {
          name: 'volume',
          image: 'alpine',
          command: ['sh'],
          tty: true,
          volumeMounts: mounts,
          resources: TRANSFER_POD_RESOURCES,
          ...getContainerSecurity(env),
        },
      ],
      volumes,
    },
  }

  service.status.write('debug', `create pod ${name}`)
  await removeStalePod(instance, env.namespace, name)
  const pod = await applyWithinQuota(instance, podSpec, service, QUOTA_TIMEOUT, 2000, signal)

  if (pod.status?.phase !== 'Running') {
    service.status.write('debug', `await running state ${name}`)
    await awaitRunningState(instance, env, name, 'Running')
  }

  try {
    await fn(name)
  } finally {
    service.status.write('debug', `delete pod ${name}`)
    await instance.coreApi.deleteNamespacedPod({ name, namespace: env.namespace })
  }
}

// Empties the claim of `work` in an upload pod: a kept claim an earlier run left, before
// the task runs on it or outputs are restored into it, so it holds what a new one would
export async function clearClaim(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  pod: string
): Promise<void> {
  const targetPath = `/dev/hammerkit/${work.id()}`
  work.status.write('info', `clear what an earlier run left in ${targetPath}`)
  const failure = await execInPod(instance, env, pod, [
    'find',
    targetPath,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-exec',
    'rm',
    '-rf',
    '{}',
    '+',
  ])
  if (failure) {
    throw new Error(`unable to clear ${targetPath} in ${pod}: ${failure}`)
  }
}

// Runs `command` in the upload pod `pod`: what failed, or null when it went well
export async function execInPod(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  pod: string,
  command: string[]
): Promise<string | null> {
  let failure: string | null = null
  const res = await instance.exec.exec(
    env.namespace,
    pod,
    'volume',
    command,
    process.stdout,
    process.stderr,
    null,
    false,
    (status) => {
      if (status.status !== 'Success') {
        failure = status.message ?? status.reason ?? 'unknown'
      }
    }
  )
  await new Promise<void>((resolve, reject) => {
    res.on('error', reject)
    res.on('close', () => resolve())
  })
  return failure
}

// marks the folder of a state whose upload went through
const UPLOADED = '.uploaded'

// Removes the folders of the states (see getStateFilesDir) in the claim at `$1` but those
// named after it: the one the work runs at, and the ones pods of the run mount
// (it says how it went itself: a loop ends with the status of its last test in some shells)
export const REMOVE_OTHER_STATES = `cd "$1" || exit 1
shift
for d in ${STATE_FILES_PREFIX}*; do
  if [ ! -d "$d" ]; then continue; fi
  keep=
  for k in "$@"; do
    if [ "$d" = "$k" ]; then keep=1; fi
  done
  if [ -z "$keep" ]; then rm -rf "$d" || exit 1; fi
done
exit 0`

/**
 * The folders of the states (see getStateFilesDir) of the claim `claim` that the services of
 * the run mount: the pods of its Deployments, which serve or start. A pod of a service mounts
 * the outputs of a task only after the task completed, so what it mounts is whole.
 */
export async function getStateDirsInUse(
  instance: KubernetesInstance,
  namespace: string,
  claim: string
): Promise<Set<string>> {
  const pods = await instance.coreApi.listNamespacedPod({ namespace })
  const dirs = new Set<string>()
  for (const pod of pods.items) {
    const phase = pod.status?.phase
    if (
      (phase !== 'Running' && phase !== 'Pending') ||
      !pod.metadata?.ownerReferences?.some((owner) => owner.kind === 'ReplicaSet')
    ) {
      continue
    }
    const volumes = new Set(
      (pod.spec?.volumes ?? [])
        .filter((volume) => volume.persistentVolumeClaim?.claimName === claim)
        .map((volume) => volume.name)
    )
    for (const container of [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])]) {
      for (const mount of container.volumeMounts ?? []) {
        const dir = mount.subPath?.split('/')[0]
        if (volumes.has(mount.name) && dir?.startsWith(STATE_FILES_PREFIX)) {
          dirs.add(dir)
        }
      }
    }
  }
  return dirs
}

// Syncs the files in the claim from the folder at `$1` into the folder at `$2` (see
// LIVE_FILES_DIR), which the pod of a service mounts while it runs: what is new or changed
// is written, what is gone is removed, and nothing else is touched, so the service sees only
// the changes. A file is written in place, and the paths the pod mounts (the others) are never
// removed: the pod holds them by their inode, and would not see one made again.
export const SYNC_FILES = `src="$1"
dst="$2"
shift 2
if [ ! -d "$src" ]; then echo "no files at $src" >&2; exit 1; fi
mkdir -p "$dst" || exit 1
cd "$src" || exit 1
find . -mindepth 1 ! -path ./${UPLOADED} | while IFS= read -r f; do
  t="$dst/$f"
  if [ -L "$f" ]; then
    l=$(readlink "$f")
    if [ -L "$t" ] && [ "$(readlink "$t")" = "$l" ]; then continue; fi
    rm -rf "$t" && ln -s "$l" "$t" || exit 1
  elif [ -d "$f" ]; then
    if [ -L "$t" ] || { [ -e "$t" ] && [ ! -d "$t" ]; }; then rm -rf "$t" || exit 1; fi
    mkdir -p "$t" || exit 1
  else
    if [ -L "$t" ] || [ -d "$t" ]; then rm -rf "$t" || exit 1; fi
    if [ -e "$t" ]; then
      if cmp -s "$f" "$t"; then continue; fi
      cat "$f" > "$t" && chmod "$(stat -c %a "$f")" "$t" || exit 1
    else
      cp -p "$f" "$t" || exit 1
    fi
  fi
done || exit 1
cd "$dst" || exit 1
find . -mindepth 1 -depth | while IFS= read -r f; do
  if [ -e "$src/$f" ] || [ -L "$src/$f" ]; then continue; fi
  mounted=
  for m in "$@"; do
    if [ "$f" = "./$m" ]; then mounted=1; fi
  done
  if [ -z "$mounted" ]; then rm -rf "$f" || exit 1; fi
done || exit 1
exit 0`

/**
 * Syncs the files of the state `from` (see getStateFilesDir) into the folder the pod of a
 * service that watches its files mounts them from (LIVE_FILES_DIR).
 */
export async function syncLiveFiles(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  work: WorkItem<ContainerWorkService>,
  persistence: Pick<KubernetesPersistence, 'mounts'>,
  pod: string,
  from: string
): Promise<void> {
  const root = `/dev/hammerkit/${work.id()}`
  // the paths of the folder its pod mounts
  const mounted = persistence.mounts.flatMap(({ mount }) =>
    mount.subPath?.startsWith(`${LIVE_FILES_DIR}/`) ? [mount.subPath.slice(LIVE_FILES_DIR.length + 1)] : []
  )
  const failure = await execInPod(instance, env, pod, [
    'sh',
    '-c',
    SYNC_FILES,
    'sh',
    `${root}/${from}`,
    `${root}/${LIVE_FILES_DIR}`,
    ...mounted,
  ])
  if (failure) {
    throw new Error(`unable to sync the files of ${work.name} into ${root}/${LIVE_FILES_DIR}: ${failure}`)
  }
}

// Puts the files of the state `from` back into the folder the pod of a service that watches
// its files mounts them from: a move that did not get up leaves the service at the commit
// it was at
export async function restoreLiveFiles(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  work: WorkItem<ContainerWorkService>,
  persistence: KubernetesPersistence,
  from: string
): Promise<void> {
  await getPodForPersistence(instance, env, work, persistence, 'write', undefined, (pod) =>
    syncLiveFiles(instance, env, work, persistence, pod, from)
  )
}

// Prepares the folder of a state in the claim of a work item of a service run before its
// upload: the folders of other states go, but the ones pods of the run mount. A folder a pod
// mounts is not touched: when it is the one of this state, its files are there already.
// Returns whether the upload is needed.
async function prepareStateFiles(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  pod: string,
  dir: string,
  inUse: Set<string>
): Promise<boolean> {
  const targetPath = `/dev/hammerkit/${work.id()}`
  await removeOtherStates(instance, env, pod, targetPath, dir, inUse)
  if (inUse.has(dir) && !(await execInPod(instance, env, pod, ['test', '-e', `${targetPath}/${dir}/${UPLOADED}`]))) {
    work.status.write('info', `the files of ${work.name} are there already`)
    return false
  }
  await clearStateDir(instance, env, pod, `${targetPath}/${dir}`)
  return true
}

// Makes each of `files` (paths in the claim of `work`, see KubernetesPersistence.files) an
// empty file unless it is one: Kubernetes would make a directory of a subPath that isn't
// there, and the task could not write the file. A directory there is what an earlier
// version left in a kept claim, and goes. A path ending in `/` is made a folder.
export const ENSURE_OUTPUT_FILES = `cd "$1" || exit 1
shift
for f; do
  case "$f" in */) mkdir -p "$f" || exit 1; continue ;; esac
  if [ -d "$f" ] && [ ! -L "$f" ]; then rm -rf "$f" || exit 1; fi
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then mkdir -p "$(dirname "$f")" && : > "$f" || exit 1; fi
done`

async function ensureOutputFiles(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  pod: string,
  files: string[]
): Promise<void> {
  if (files.length === 0) {
    return
  }
  const made = await execInPod(instance, env, pod, [
    'sh',
    '-c',
    ENSURE_OUTPUT_FILES,
    'sh',
    `/dev/hammerkit/${work.id()}`,
    ...files,
  ])
  if (made) {
    throw new Error(`unable to make the output files ${files.join(', ')} of ${work.name}: ${made}`)
  }
}

// what a failed upload, restore or task left: tar does not remove files the commit does not have
async function clearStateDir(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  pod: string,
  path: string
): Promise<void> {
  const cleared = await execInPod(instance, env, pod, ['rm', '-rf', path])
  if (cleared) {
    throw new Error(`unable to clear ${path}: ${cleared}`)
  }
}

// Before a restore of a service run into the folder `dir` of the claim of `work` (in its upload
// pod `pod`): the folders of the other states go but those of `inUse`, which pods of the run
// mount, and `dir` is emptied. A claim that took only restores holds one state, as after a Job.
export async function clearStateFiles(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  pod: string,
  dir: string,
  inUse: Set<string>
): Promise<void> {
  const targetPath = `/dev/hammerkit/${work.id()}`
  await removeOtherStates(instance, env, pod, targetPath, dir, inUse)
  await clearStateDir(instance, env, pod, `${targetPath}/${dir}`)
}

async function removeOtherStates(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  pod: string,
  targetPath: string,
  dir: string,
  inUse: Set<string>
): Promise<void> {
  const removed = await execInPod(instance, env, pod, [
    'sh',
    '-c',
    REMOVE_OTHER_STATES,
    'sh',
    targetPath,
    dir,
    ...[...inUse].sort(),
  ])
  if (removed) {
    throw new Error(`unable to remove the files of other commits in ${targetPath}: ${removed}`)
  }
}

// The archive that uploads a source into the claim: its file or directory, at its place in
// the claim (see getClaimSubPath) instead of under its own name
export function packSource(source: Pick<KubernetesPersistenceSource, 'localPath' | 'subPath' | 'matcher'>): Readable {
  const fileItem = basename(source.localPath)
  return Readable.from(
    packArchive(
      {
        cwd: dirname(source.localPath),
        filter(path: string): boolean {
          return source.matcher(path, source.localPath)
        },
        onWriteEntry(entry) {
          entry.path = source.subPath + entry.path.slice(fileItem.length)
          // the second of two hard-linked files links to the first by its path in the archive
          if (entry.type === 'Link' && entry.linkpath?.startsWith(fileItem)) {
            entry.linkpath = source.subPath + entry.linkpath.slice(fileItem.length)
          }
        },
      },
      [fileItem]
    )
  )
}

export async function ensurePersistentData(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  environment: Environment,
  service: WorkItem<ContainerWorkService | ContainerWorkTask>,
  persistence: KubernetesPersistence,
  // the kept claim of the work holds what an earlier run left, which goes first
  options: {
    reset?: boolean
    // a work item of a service run: its files go into `dir`, the folder of their state (see
    // getStateFilesDir), next to the ones pods of the run mount and the ones in `keep`. With
    // `live`, a service that watches its files: they are synced from there into the folder
    // its pod mounts (syncLiveFiles).
    files?: { dir: string; keep?: string[]; live?: boolean }
  } = {}
) {
  // what a run of a server uploads comes from its checkout and nowhere else
  if (environment.hosted) {
    await assertItemPathsWithinRoot(service, environment.cwd)
  }

  // Dedupe of already-uploaded state (skip the upload when the persisted state
  // key still matches) needs an in-cluster state marker per volume — deferred
  // post-1.6.0, tracked in FOLLOWUPS.md alongside the volumes.ts stateKey/matcher.

  for (const volume of persistence.volumes) {
    await ensureKubernetesPersistentVolumeClaimExists(
      instance,
      env,
      volume,
      service,
      persistence.sizes[volume.name],
      persistence.kept.includes(volume.name)
    )
  }

  // the folder of the state is in the work's own claim: one that has none (a service that
  // only mounts what its deps made) has nothing to prepare
  const claim = getVolumeName(service, env)
  const files = persistence.volumes.some((volume) => volume.persistentVolumeClaim?.claimName === claim)
    ? options.files
    : undefined
  if (persistence.sources.length === 0 && persistence.files.length === 0 && !options.reset && !files) {
    return
  }
  // the folders of the states the pods of the run mount, before the upload pod mounts the claim
  const inUse = files ? await getStateDirsInUse(instance, env.namespace, claim) : new Set<string>()
  for (const dir of files?.keep ?? []) {
    inUse.add(dir)
  }

  service.status.write('debug', 'start upload container')
  const { signal } = environment.abortCtrl
  await getPodForPersistence(instance, env, service, persistence, 'write', signal, async (name) => {
    if (options.reset) {
      await clearClaim(instance, env, service, name)
    }
    if (files && !(await prepareStateFiles(instance, env, service, name, files.dir, inUse))) {
      if (files.live && service.data.type === 'container-service') {
        await syncLiveFiles(instance, env, service as WorkItem<ContainerWorkService>, persistence, name, files.dir)
      }
      return
    }
    for (const source of persistence.sources) {
      // skip sources that don't exist on disk — nothing to upload
      if (!(await environment.file.exists(source.localPath))) {
        continue
      }

      const data = packSource(source)

      service.status.write('info', `upload ${source.localPath}`)
      const targetPath = `/dev/hammerkit/${service.id()}`
      const res = await instance.exec.exec(
        env.namespace,
        name,
        'volume',
        ['tar', 'xf', '-', '-C', targetPath],
        process.stdout,
        process.stderr,
        data,
        false,
        (status) => {
          service.status.write('debug', `upload ${source.localPath} to ${name}: ${status}`)
        }
      )
      await new Promise<void>((resolve, reject) => {
        try {
          res.on('open', () => {
            service.status.write('debug', `start upload of ${source} to ${name}:${targetPath}`)
          })
          res.on('error', (err) => {
            service.status.write(
              'error',
              `error during upload of ${source.localPath} to ${name}: ${getErrorMessage(err)}`
            )
            reject(err)
          })
          res.on('close', () => {
            service.status.write('debug', `uploaded ${source.localPath} to ${name}:${targetPath}`)
            resolve()
          })
        } catch (e) {
          reject(e)
        }
      })
    }
    await ensureOutputFiles(instance, env, service, name, persistence.files)
    if (files) {
      const dir = `/dev/hammerkit/${service.id()}/${files.dir}`
      const marked = await execInPod(instance, env, name, [
        'sh',
        '-c',
        'mkdir -p "$1" && touch "$1/$2"',
        'sh',
        dir,
        UPLOADED,
      ])
      if (marked) {
        throw new Error(`unable to mark the upload of ${dir}: ${marked}`)
      }
      if (files.live && service.data.type === 'container-service') {
        await syncLiveFiles(instance, env, service as WorkItem<ContainerWorkService>, persistence, name, files.dir)
      }
    }
  })
}
