import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { KubernetesPersistence, KubernetesPersistenceSource } from './volumes'
import { V1Pod, V1VolumeMount } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { basename, dirname } from 'path'
import { packArchive } from '../utils/tar'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'
import { awaitRunningState } from './await-running-state'
import { sleep } from '../utils/sleep'
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

export async function getPodForPersistence(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService | ContainerWorkTask>,
  persistence: KubernetesPersistence,
  type: 'read' | 'write',
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
      ? own.map((m) => m.mount)
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

  // Guarantee the claims exist right before scheduling the pod that mounts
  // them. ensurePersistentData also creates them, but store/restore reach this
  // function directly, and a claim shared with another work item can be removed
  // concurrently — without this the pod would hang Pending on "pvc not found".
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

  const name = getResourceName(service, type === 'write' ? '-upload' : '-download')
  const podSpec: V1Pod & KubernetesObjectHeader = {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      labels: {
        'hammerkit.dev/id': service.id(),
        ...getRunLabels(env),
      },
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
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
          ...getContainerSecurity(env),
        },
      ],
      volumes: persistence.volumes,
    },
  }

  service.status.write('debug', `create pod ${name}`)
  await removeStalePod(instance, env.namespace, name)
  const pod = await apply(instance, podSpec)

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
  let failure: string | null = null
  const res = await instance.exec.exec(
    env.namespace,
    pod,
    'volume',
    ['find', targetPath, '-mindepth', '1', '-maxdepth', '1', '-exec', 'rm', '-rf', '{}', '+'],
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
    res.on('close', () =>
      failure ? reject(new Error(`unable to clear ${targetPath} in ${pod}: ${failure}`)) : resolve()
    )
  })
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
  options: { reset?: boolean } = {}
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

  if (persistence.sources.length === 0 && !options.reset) {
    return
  }

  service.status.write('debug', 'start upload container')
  await getPodForPersistence(instance, env, service, persistence, 'write', async (name) => {
    if (options.reset) {
      await clearClaim(instance, env, service, name)
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
  })
}
