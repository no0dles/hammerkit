import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { KubernetesPersistence } from './volumes'
import { V1Pod } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader } from './apply'
import { basename, dirname } from 'path'
import { create } from 'tar'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'
import { awaitRunningState } from './await-running-state'
import { getVersion } from '../version'
import { getErrorMessage } from '../log'
import { ContainerWorkTask } from '../planner/work-task'
import { ensureKubernetesPersistentVolumeClaimExists } from './ensure-kubernetes-persistent-volume-claim-exists'
import { Environment } from '../executer/environment'
import { V1VolumeMount } from '@kubernetes/client-node/dist/gen/model/v1VolumeMount'

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

  // TODO remove old upload pods

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
  // TODO check if state is already uploaded

  for (const volume of persistence.volumes) {
    await ensureKubernetesPersistentVolumeClaimExists(instance, env, volume, service)
  }

  if (persistence.sources.length === 0) {
    return
  }

  service.status.console('stdout', 'start upload container')
  // TODO check if file exists
  await getPodForPersistence(instance, env, service, persistence, 'write', async (name) => {
    for (const source of persistence.sources) {
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
