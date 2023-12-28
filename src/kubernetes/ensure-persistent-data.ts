import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { getVolumeMounts, getVolumes, KubernetesPersistence } from './volumes'
import { V1Pod } from '@kubernetes/client-node'
import { apply } from './apply'
import { dirname, relative } from 'path'
import { create, FileStat } from 'tar'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'
import { awaitRunningState } from './await-running-state'
import { getVersion } from '../version'
import { getErrorMessage } from '../log'
import { ContainerWorkTask } from '../planner/work-task'
import {
  ensureKubernetesConfigMap,
  ensureKubernetesPersistentVolumeClaimExists,
} from './ensure-kubernetes-persistent-volume-claim-exists'
import { Environment } from '../executer/environment'

export async function ensurePersistentData(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  environment: Environment,
  service: WorkItem<ContainerWorkService | ContainerWorkTask>,
  persistence: KubernetesPersistence
) {
  if (persistence.volumes.length === 0 && persistence.configMaps.length === 0) {
    return
  }

  for (const configMap of persistence.configMaps) {
    await ensureKubernetesConfigMap(instance, env, environment, configMap)
  }

  for (const volume of persistence.volumes) {
    await ensureKubernetesPersistentVolumeClaimExists(instance, env, volume)
  }

  if (!persistence.volumes.some((v) => v.sources.length > 0)) {
    return
  }

  // TODO check if state is already uploaded

  const name = getResourceName(service, '-upload')
  const podSpec: V1Pod = {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      labels: {
        'hammerkit.dev/id': service.cacheId(),
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
          volumeMounts: getVolumeMounts(persistence),
        },
      ],
      volumes: getVolumes(persistence),
    },
  }

  // TODO check if file exists

  const pod = await apply(
    instance,
    {
      kind: 'Pod',
      apiVersion: 'v1',
      metadata: {
        namespace: env.namespace,
        name,
      },
    },
    podSpec
  )

  if (pod.status?.phase !== 'Running') {
    await awaitRunningState(instance, env, name, 'Running')
  }

  for (const volume of persistence.volumes) {
    for (const source of volume.sources) {
      if (!(await environment.file.exists(source.localPath))) {
        continue
      }

      const fileItem = relative(source.localCwd, source.localPath)
      const data = create(
        {
          cwd: source.localCwd,
          //gzip: true,
          filter(path: string): boolean {
            return source.matcher(path, source.localPath)
          },
        },
        [fileItem]
      )

      const res = await instance.exec.exec(
        env.namespace,
        name,
        'volume',
        ['tar', 'xf', '-', '-C', dirname(source.containerPath)],
        process.stdout,
        process.stderr,
        data,
        false
      )
      await new Promise<void>((resolve, reject) => {
        try {
          res.on('open', () => {
            service.status.write('debug', `start upload of ${source} to ${name}`)
          })
          res.on('error', (err) => {
            service.status.write('error', `error during upload of ${source} to ${name}: ${getErrorMessage(err)}`)
            reject(err)
          })
          res.on('close', () => {
            service.status.write('debug', `uploaded ${source} to ${name}`)
            resolve()
          })
        } catch (e) {
          reject(e)
        }
      })
    }
  }

  await instance.coreApi.deleteNamespacedPod(name, env.namespace)
}
