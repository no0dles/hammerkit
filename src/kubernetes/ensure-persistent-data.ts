import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { KubernetesPersistence } from './volumes'
import { V1Pod } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { basename, dirname } from 'path'
import { create } from 'tar'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'
import { awaitRunningState } from './await-running-state'
import { sleep } from '../utils/sleep'
import { getVersion } from '../version'
import { getErrorMessage } from '../log'
import { ContainerWorkTask } from '../planner/work-task'
import { ensureKubernetesPersistentVolumeClaimExists } from './ensure-kubernetes-persistent-volume-claim-exists'
import { Environment } from '../executer/environment'
import { V1VolumeMount } from '@kubernetes/client-node/dist/gen/model/v1VolumeMount'

// A previous run that crashed between creating an upload/download pod and its
// `finally` cleanup leaves a pod behind under the same deterministic name. apply()
// would then patch that stale pod in place — and if it is stuck in a terminal
// phase the subsequent awaitRunningState never resolves. Force-delete any leftover
// and wait for it to disappear before scheduling a fresh one.
async function removeStalePod(instance: KubernetesInstance, namespace: string, name: string): Promise<void> {
  try {
    await instance.coreApi.deleteNamespacedPod(name, namespace, undefined, undefined, 0)
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return
    }
    throw e
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await instance.coreApi.readNamespacedPod(name, namespace)
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

  const mounts: V1VolumeMount[] =
    type === 'read'
      ? persistence.mounts.map((m) => m.mount)
      : persistence.mounts.reduce<V1VolumeMount[]>((array, v) => {
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
    await ensureKubernetesPersistentVolumeClaimExists(instance, env, volume, service)
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
      },
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
      containers: [
        {
          name: 'volume',
          image: 'alpine',
          command: ['sh'],
          tty: true,
          volumeMounts: mounts,
        },
      ],
      volumes: persistence.volumes,
    },
  }

  service.status.console('stdout', `create pod ${name}`)
  await removeStalePod(instance, env.namespace, name)
  const pod = await apply(instance, podSpec)

  if (pod.status?.phase !== 'Running') {
    service.status.console('stdout', `await running state ${name}`)
    await awaitRunningState(instance, env, name, 'Running')
  }

  try {
    await fn(name)
  } finally {
    service.status.console('stdout', `delete pod ${name}`)
    await instance.coreApi.deleteNamespacedPod(name, env.namespace)
  }
}

export async function ensurePersistentData(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  environment: Environment,
  service: WorkItem<ContainerWorkService | ContainerWorkTask>,
  persistence: KubernetesPersistence
) {
  // Dedupe of already-uploaded state (skip the upload when the persisted state
  // key still matches) needs an in-cluster state marker per volume — deferred
  // post-1.6.0, tracked in FOLLOWUPS.md alongside the volumes.ts stateKey/matcher.

  for (const volume of persistence.volumes) {
    await ensureKubernetesPersistentVolumeClaimExists(instance, env, volume, service)
  }

  if (persistence.sources.length === 0) {
    return
  }

  service.status.console('stdout', 'start upload container')
  await getPodForPersistence(instance, env, service, persistence, 'write', async (name) => {
    for (const source of persistence.sources) {
      // skip sources that don't exist on disk — nothing to upload
      if (!(await environment.file.exists(source.localPath))) {
        continue
      }

      const fileItem = basename(source.localPath)
      const data = create(
        {
          cwd: dirname(source.localPath),
          filter(path: string): boolean {
            return source.matcher(path, source.localPath)
          },
        },
        [fileItem]
      )

      service.status.console('stdout', `upload ${source.localPath}`)
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
