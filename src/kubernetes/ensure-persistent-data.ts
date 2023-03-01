import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { KubernetesServiceVolume } from './volumes'
import { V1Pod } from '@kubernetes/client-node'
import { apply } from './apply'
import { dirname, relative } from 'path'
import { create } from 'tar'
import { KubernetesInstance } from './kubernetes-instance'
import { getResourceName } from './resources'
import { awaitRunningState } from './await-running-state'
import { getVersion } from '../version'
import { getErrorMessage } from '../log'

export async function ensurePersistentData(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  service: WorkItem<ContainerWorkService>,
  volumes: KubernetesServiceVolume[]
) {
  if (volumes.length === 0) {
    return
  }

  const name = getResourceName(service, '-data-mount')
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
          volumeMounts: volumes.map((v) => v.volumeMount),
        },
      ],
      volumes: volumes.map((v) => v.volume),
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
    await awaitRunningState(instance, env, name)
  }

  for (const volume of volumes) {
    for (const localPath of volume.localPaths) {
      const localCwd = dirname(localPath)
      const data = create(
        {
          cwd: localCwd,
          //gzip: true,
        },
        [relative(localCwd, localPath)]
      )

      const res = await instance.exec.exec(
        env.namespace,
        name,
        'volume',
        ['tar', 'xf', '-', '-C', volume.containerPath],
        process.stdout,
        process.stderr,
        data,
        false
      )
      await new Promise<void>((resolve, reject) => {
        try {
          res.on('open', () => {
            service.status.write('debug', `start upload of ${localPath} to ${name}`)
          })
          res.on('error', (err) => {
            service.status.write('error', `error during upload of ${localPath} to ${name}: ${getErrorMessage(err)}`)
            reject(err)
          })
          res.on('close', () => {
            service.status.write('debug', `uploaded ${localPath} to ${name}`)
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
