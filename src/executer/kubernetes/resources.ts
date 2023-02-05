import { KubernetesObject } from '@kubernetes/client-node/dist/types'
import { ContainerWorkService, WorkService } from '../../planner/work-service'
import {
  CoreV1Api,
  Exec,
  KubeConfig,
  KubernetesObjectApi,
  V1Container,
  V1Deployment,
  V1HostAlias,
  V1Ingress,
  V1PersistentVolumeClaim,
  V1Pod,
  V1Service,
  Watch,
} from '@kubernetes/client-node'
import { getContainer, KubernetesServiceVolume } from './volumes'
import { create } from 'tar'
import { dirname, relative } from 'path'
import { BuildFileEnvironment, BuildFileEnvironmentIngress } from '../../parser/build-file-environment'
import { isContainerWorkServiceItem, WorkItem } from '../../planner/work-item'

function getVersion(): string {
  return require('../../../package.json').version
}

const kc = new KubeConfig()
kc.loadFromDefault()

const k8sApi = kc.makeApiClient(CoreV1Api)
const objectApi = kc.makeApiClient(KubernetesObjectApi)
const k8sExec = new Exec(kc)
const watch = new Watch(kc)

export async function apply<T extends KubernetesObject>(
  selector: {
    metadata: {
      name: string
      namespace: string
    }
  } & Pick<KubernetesObject, 'apiVersion' | 'kind'>,
  spec: T
) {
  try {
    // try to get the resource, if it does not exist an error will be thrown and we will end up in the catch
    // block.
    await objectApi.read(selector)
    // we got the resource, so it exists, so patch it
    //
    // Note that this could fail if the spec refers to a custom resource. For custom resources you may need
    // to specify a different patch merge strategy in the content-type header.
    //
    // See: https://github.com/kubernetes/kubernetes/issues/97423
    const response = await objectApi.patch(spec)
    return response.body
  } catch (e) {
    // we did not get the resource, so it does not exist, so create it
    const response = await objectApi.create(spec)
    return response.body
  }
}

export async function ensureKubernetesPersistentVolumeClaimExists(
  env: BuildFileEnvironment,
  service: WorkService,
  name: string
): Promise<V1PersistentVolumeClaim> {
  const pvc: V1PersistentVolumeClaim = {
    kind: 'PersistentVolumeClaim',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: 'local-path',
      resources: {
        requests: {
          storage: '1Gi',
        },
      },
    },
  }
  return await apply(
    {
      kind: 'PersistentVolumeClaim',
      apiVersion: 'v1',
      metadata: {
        namespace: env.namespace,
        name,
      },
    },
    pvc
  )
}

function getServiceName(service: WorkItem<WorkService>) {
  return `${service.name.replace(/:/, '-')}-${service.id}`
}

export async function ensureKubernetesServiceExists(env: BuildFileEnvironment, service: WorkItem<WorkService>) {
  const name = getServiceName(service)

  const svc: V1Service = {
    kind: 'Service',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
      type: 'ClusterIP',
      selector: {
        'hammerkit.dev/id': service.id,
      },
      ports: service.data.ports.map((port) => ({
        port: port.hostPort ?? port.containerPort,
        targetPort: port.containerPort,
      })),
    },
  }

  return await apply(
    {
      kind: 'Service',
      apiVersion: 'v1',
      metadata: {
        namespace: env.namespace,
        name,
      },
    },
    svc
  )
}

export async function getServiceIp(
  env: BuildFileEnvironment,
  workService: WorkItem<ContainerWorkService>
): Promise<string> {
  const name = getServiceName(workService)
  const svc = await k8sApi.readNamespacedService(name, env.namespace)

  return svc.body.spec?.clusterIP!
}

export async function ensureKubernetesDeploymentExists(
  env: BuildFileEnvironment,
  service: WorkItem<ContainerWorkService>,
  volumes: KubernetesServiceVolume[]
) {
  const hostAliases: V1HostAlias[] = []
  for (const need of service.needs) {
    if (!isContainerWorkServiceItem(need.service)) {
      continue
    }
    const ip = await getServiceIp(env, need.service)
    hostAliases.push({
      ip,
      hostnames: [need.name],
    })
  }
  const deployment: V1Deployment = {
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    metadata: {
      namespace: env.namespace,
      name: service.name.replace(/:/, '-'),
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
      selector: {
        matchLabels: {
          'hammerkit.dev/id': service.id,
        },
      },
      replicas: 1,
      template: {
        metadata: {
          labels: {
            'hammerkit.dev/id': service.id,
          },
        },
        spec: {
          initContainers: service.deps.reduce<V1Container[]>(
            (containers, d) => [...containers, ...getContainer(d.data, volumes)],
            []
          ),
          hostAliases: hostAliases,
          containers: [
            {
              name: service.name.replace(/:/, '-'),
              image: service.data.image,
              workingDir: service.data.cwd ?? undefined,
              env: Object.keys(service.data.envs).map((key) => ({
                name: key,
                value: service.data.envs[key],
              })),
              command: service.data.cmd ? [service.data.cmd.parsed.command] : undefined,
              args: service.data.cmd ? service.data.cmd.parsed.args : undefined,
              ports: service.data.ports.map((p) => ({
                containerPort: p.containerPort,
              })),
              volumeMounts: volumes.map((v) => v.volumeMount),
            },
            {
              name: 'debug',
              image: 'alpine',
              command: ['sleep'],
              args: ['3600'],
              volumeMounts: volumes.map((v) => v.volumeMount),
            },
          ],
          volumes: volumes.map((v) => v.volume),
        },
      },
    },
  }
  return await apply(
    {
      kind: 'Deployment',
      apiVersion: 'apps/v1',
      metadata: {
        namespace: env.namespace,
        name: service.name.replace(/:/, '-'),
      },
    },
    deployment
  )
}

export async function ensureIngress(
  env: BuildFileEnvironment,
  ingress: BuildFileEnvironmentIngress,
  service: WorkItem<ContainerWorkService>
) {
  const resource: V1Ingress = {
    kind: 'Ingress',
    apiVersion: 'networking.k8s.io/v1',
    metadata: {
      name: ingress.host,
      namespace: env.namespace,
      annotations: {
        'cert-manager.io/cluster-issuer': 'hammerkit-issuer',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: ingress.host,
          http: {
            paths: [
              {
                path: ingress.path,
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: getServiceName(service),
                    port: {
                      number: ingress.servicePort,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: [
        {
          secretName: `${ingress.host}-tls`,
          hosts: [ingress.host],
        },
      ],
    },
  }
  return await apply(
    {
      kind: 'Ingress',
      apiVersion: 'networking.k8s.io/v1',
      metadata: {
        namespace: env.namespace,
        name: resource.metadata!.name!,
      },
    },
    resource
  )
}

export async function ensurePersistentData(
  env: BuildFileEnvironment,
  service: WorkItem<ContainerWorkService>,
  volumes: KubernetesServiceVolume[]
) {
  if (volumes.length === 0) {
    return
  }

  const name = service.name.replace(/:/, '-') + '-data-mount'
  const podSpec: V1Pod = {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      labels: {
        'hammerkit.dev/id': service.id,
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
    await awaitRunningState(env, name)
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

      try {
        await new Promise<void>(async (resolve, reject) => {
          try {
            const res = await k8sExec.exec(
              env.namespace,
              pod.metadata?.name!,
              'volume',
              ['tar', 'xf', '-', '-C', volume.containerPath],
              process.stdout,
              process.stderr,
              data,
              false
            )
            //console.log(res)
            res.on('open', () => console.log('open'))
            res.on('error', () => console.log('error'))
            res.on('close', () => {
              console.log('transmitted ' + localPath)
              resolve()
            })
          } catch (e) {
            reject(e)
          }
        })
      } catch (e) {
        console.log(e)
      }
    }
  }

  await k8sApi.deleteNamespacedPod(podSpec.metadata?.name!, env.namespace)
}

function awaitRunningState(env: BuildFileEnvironment, name: string) {
  return new Promise<void>(async (resolve, reject) => {
    const req = await watch.watch(
      `/api/v1/pods`,
      {},
      (type, obj, watch) => {
        if (obj.metadata.name === name && obj.metadata.namespace === env.namespace && obj.status.phase === 'Running') {
          req.abort()
          resolve()
        }
      },
      (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }
    )
  })
}
