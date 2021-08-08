import { KubeConfig, CoreV1Api, Exec, Watch, V1Pod } from '@kubernetes/client-node'
import { Executor } from './executor'
import { ExecutionContext } from './execution-context'
import { ContainerWorkNode, WorkNode } from '../planner/work-node'
import { Defer } from '../utils/defer'
import { WorkNodeCommand } from '../planner/work-node-command'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { FileContext } from '../file/file-context'
import { iterateFiles } from '../file/iterate-files'
import { relative, join, dirname, basename } from 'path'

interface ConfigMap {
  name: string
  containerPath: string
  files: { [key: string]: { fileName: string; content: string } }
}

export async function getConfigMapData(
  workTree: WorkTree,
  node: ContainerWorkNode,
  file: FileContext
): Promise<ConfigMap[]> {
  const data: { [key: string]: ConfigMap } = {}

  const sources: {
    localPath: string
    containerPath: string
    matcher: (fileName: string, cwd: string) => boolean
  }[] = []

  for (const src of node.src) {
    sources.push({
      matcher: src.matcher,
      localPath: src.absolutePath,
      containerPath: src.absolutePath,
    })
  }

  for (const mount of node.mounts) {
    sources.push({
      localPath: mount.localPath,
      containerPath: mount.containerPath,
      matcher: () => true,
    })
  }

  for (const otherNode of iterateWorkNodes(workTree.nodes)) {
    for (const generate of otherNode.generates) {
      const index = sources.findIndex((s) => s.localPath === generate)
      if (index >= 0) {
        sources.splice(index, 1)
      }
    }
  }

  for (const src of sources) {
    for await (const entry of iterateFiles(src.localPath, file)) {
      const containerPath = join(src.containerPath, relative(src.localPath, entry))
      const containerDir = dirname(containerPath)
      const configMapName = 'config-' + node.id + formatValue(containerDir)

      if (!(containerPath in data)) {
        data[configMapName] = { name: configMapName, files: {}, containerPath: containerDir }
      }
      const configMap = data[configMapName]
      const fileName = basename(containerPath)
      configMap.files[formatValue(fileName)] = {
        fileName: fileName,
        content: await file.read(entry), //new Buffer().toString('base64'),
      }
    }
  }

  return Object.keys(data).map((k) => data[k])
}

function formatValue(val: string) {
  return val.replace(/[^\-A-Za-z0-9]/g, '-').toLocaleLowerCase()
}

async function createConfigMap(
  api: CoreV1Api,
  workTree: WorkTree,
  node: ContainerWorkNode,
  file: FileContext
): Promise<ConfigMap[]> {
  const configMaps = await getConfigMapData(workTree, node, file)

  const appliedConfigMaps = await api.listNamespacedConfigMap('default')
  for (const configMap of configMaps) {
    await handleApiError(async () => {
      const existingConfigMap = appliedConfigMaps.body.items.find((i) => i.metadata?.name === configMap.name)
      if (!existingConfigMap) {
        await api.createNamespacedConfigMap('default', {
          metadata: {
            name: configMap.name,
            labels: {
              app: 'hammerkit',
            },
          },
          kind: 'ConfigMap',
          apiVersion: 'v1',
          data: Object.keys(configMap.files).reduce<{ [key: string]: string }>((map, key) => {
            map[key] = configMap.files[key].content
            return map
          }, {}),
        })
      } else {
        if (!existingConfigMap.data) {
          existingConfigMap.data = {}
        }

        for (const key of Object.keys(configMap.files)) {
          existingConfigMap.data[key] = configMap.files[key].content
        }

        await api.replaceNamespacedConfigMap(configMap.name, 'default', existingConfigMap)
      }
    })
  }
  return configMaps
}

async function handleApiError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (e) {
    throw new Error(e.response.body.message)
  }
}

async function cleanup(kc: KubeConfig, api: CoreV1Api, node: ContainerWorkNode) {
  await handleApiError(async () => {
    await api.deleteNamespacedPod(node.id, 'default')
    //await api.deleteNamespacedConfigMap(node.id, 'default')
  })
}

async function removePod(kc: KubeConfig, api: CoreV1Api, node: ContainerWorkNode) {
  const pods = await api.listNamespacedPod('default')

  const existingPod = pods.body.items.find((i) => i.metadata?.name === node.id)
  if (!existingPod) {
    return
  }

  await handleApiError(async () => {
    await api.deleteNamespacedPod(node.id, 'default')
  })
  await waitForPodState(kc, node.id, 'DELETED')
}

async function waitForPodState(
  kc: KubeConfig,
  podName: string,
  type: 'ADDED' | 'DELETED',
  phase?: 'Running'
): Promise<void> {
  const watch = new Watch(kc)
  const startedDefer = new Defer<void>()
  const req = await watch.watch(
    `/api/v1/pods`,
    {},
    (type, apiObject) => {
      if (
        type === type &&
        apiObject.kind === 'Pod' &&
        apiObject.metadata.name === podName &&
        (!phase || apiObject.status.phase === phase)
      ) {
        startedDefer.resolve()
        req.abort()
      }
    },
    (err) => {
      if (!startedDefer.isResolved) {
        startedDefer.reject(err)
      }
    }
  )

  return startedDefer.promise
}

interface Volume {
  name: string
  claimName: string
  containerPath: string
}

async function addVolumes(kc: KubeConfig, api: CoreV1Api, node: ContainerWorkNode): Promise<Volume[]> {
  const volumes: Volume[] = []
  for (const generate of node.generates) {
    volumes.push({
      containerPath: generate,
      name: 'gen-' + formatValue(generate),
      claimName: 'gen-' + formatValue(generate),
    })
  }

  await handleApiError(async () => {
    const existingVolumes = await api.listPersistentVolume()
    const existingVolumeClaims = await api.listNamespacedPersistentVolumeClaim('default')

    for (const volume of volumes) {
      if (existingVolumes.body.items.some((i) => i.metadata?.name === volume.claimName)) {
        continue
      }

      await api.createPersistentVolume({
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: {
          name: volume.claimName,
        },
        spec: {
          capacity: {
            storage: '1Gi',
          },
          volumeMode: 'Filesystem',
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'hostpath',
          local: {
            path: '/tmp/' + volume.claimName,
          },
          nodeAffinity: {
            required: {
              nodeSelectorTerms: [
                {
                  matchExpressions: [
                    {
                      key: 'kubernetes.io/hostname',
                      operator: 'In',
                      values: ['docker-desktop'],
                    },
                  ],
                },
              ],
            },
          },
        },
      })

      if (existingVolumeClaims.body.items.some((i) => i.metadata?.name === volume.claimName)) {
        continue
      }

      await api.createNamespacedPersistentVolumeClaim('default', {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: volume.claimName,
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          volumeMode: 'Filesystem',
          volumeName: volume.claimName,
          storageClassName: 'hostpath',
          resources: {
            requests: {
              storage: '1Gi',
            },
          },
        },
      })
    }
  })

  return volumes
}

async function startPod(kc: KubeConfig, api: CoreV1Api, node: ContainerWorkNode, configMaps: ConfigMap[]) {
  await removePod(kc, api, node)

  const volumes = await addVolumes(kc, api, node)
  const target: V1Pod = {
    metadata: {
      name: node.id,
      labels: {
        app: 'hammerkit',
      },
    },
    spec: {
      containers: [
        {
          image: node.image,
          command: ['sleep'],
          args: ['infinity'],
          workingDir: node.cwd,
          name: 'shell',
          volumeMounts: [
            ...configMaps.map((m) => ({
              name: m.name,
              mountPath: m.containerPath,
            })),
            ...volumes.map((v) => ({
              name: v.name,
              mountPath: v.containerPath,
            })),
          ],
        },
      ],
      volumes: [
        ...configMaps.map((m) => ({
          name: m.name,
          configMap: {
            name: m.name,
            items: Object.keys(m.files).map((k) => ({ key: k, path: m.files[k].fileName })),
          },
        })),
        ...volumes.map((v) => ({
          name: v.name,
          persistentVolumeClaim: {
            claimName: v.claimName,
          },
        })),
      ],
    },
  }

  await handleApiError(async () => {
    await api.createNamespacedPod('default', target)
  })

  await waitForPodState(kc, node.id, 'ADDED', 'Running')
}

export async function executeCommand(kc: KubeConfig, node: WorkNode, cmd: WorkNodeCommand) {
  const ex = new Exec(kc)
  const defer = new Defer<void>()
  await ex.exec(
    'default',
    node.id,
    'shell',
    ['sh', '-c', cmd.cmd],
    process.stdout,
    process.stderr,
    null,
    false,
    (stats) => {
      if (stats.status === 'Failure') {
        defer.reject(new Error('exit code 1'))
      } else {
        defer.resolve()
      }
      console.log(stats.status)
    }
  )
  await defer.promise
}

export function getKubernetesExecutor(): Executor {
  return {
    async exec(
      workTree: WorkTree,
      node: ContainerWorkNode,
      context: ExecutionContext,
      cancelDefer: Defer<void>
    ): Promise<void> {
      const kc = new KubeConfig()
      kc.loadFromDefault()

      const k8sApi = kc.makeApiClient(CoreV1Api)

      node.status.console.write('internal', 'debug', 'create config maps')
      const configMaps = await createConfigMap(k8sApi, workTree, node, context.environment.file)
      node.status.console.write('internal', 'debug', 'start pod')
      await startPod(kc, k8sApi, node, configMaps)

      for (const cmd of node.cmds) {
        node.status.console.write('internal', 'debug', 'execute command ' + cmd.cmd)
        await executeCommand(kc, node, cmd)
      }

      node.status.console.write('internal', 'debug', 'cleanup pod')
      await cleanup(kc, k8sApi, node)
    },
  }
}
