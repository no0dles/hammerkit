import { createHash } from 'crypto'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { ContainerWorkService } from './work-service'
import { WorkItem } from './work-item'
import { getWorkInstanceId } from './work-instance-id'
import { getItemLabels, getResourceName } from '../kubernetes/resources'
import { getNetworkPolicyName } from '../kubernetes/network-policy'
import { getLegacyServiceItem, getUnnamedWorkServiceId } from './work-service-id'
import { removeLegacyService } from './work-runtime-docker'
import { removeLegacyKubernetesService } from './work-runtime-kubernetes'

// Services that run the same image from the same directory with the same volumes and
// differ only in what they run: an app's api and its worker, or an open service beside
// one without network.
const services = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': {
    services: {
      api: { image: 'example/app:1', cmd: 'node api.js', ports: ['3000'] },
      worker: { image: 'example/app:1', cmd: 'node worker.js' },
      open: { image: 'python:3.13-slim', cmd: 'python -m http.server 8000' },
      offline: { image: 'python:3.13-slim', cmd: 'python -m http.server 8000', network: 'none' },
    },
  },
}

async function loadServices(name: string): Promise<{ [name: string]: WorkItem<ContainerWorkService> }> {
  const items: { [name: string]: WorkItem<ContainerWorkService> } = {}
  await createTestCase(name, services).setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
    for (const item of cli.ls()) {
      if (item.type === 'service') {
        items[item.item.name] = item.item as WorkItem<ContainerWorkService>
      }
    }
  })
  return items
}

describe('service id', () => {
  it('tells apart services that differ only in their command', async () => {
    const { api, worker } = await loadServices('service-id-cmd')
    expect(api.id()).not.toEqual(worker.id())
    // the label docker finds a service's container by
    expect(getWorkInstanceId(api)).not.toEqual(getWorkInstanceId(worker))
  })

  it('tells apart services that differ only in their network', async () => {
    const { open, offline } = await loadServices('service-id-network')
    expect(open.id()).not.toEqual(offline.id())
  })

  it('gives each service kubernetes objects and labels of its own', async () => {
    const { open, offline } = await loadServices('service-id-kubernetes')
    for (const env of [{}, { server: { run: 'run_1' } as any }]) {
      expect(getItemLabels(open, env)).not.toEqual(getItemLabels(offline, env))
      expect(getResourceName(open, env)).not.toEqual(getResourceName(offline, env))
    }
    expect(getNetworkPolicyName(open, { name: 'demo' } as any)).not.toEqual(
      getNetworkPolicyName(offline, { name: 'demo' } as any)
    )
    expect(getNetworkPolicyName(open, { name: 'demo', run: 'abcd1234' } as any)).not.toEqual(
      getNetworkPolicyName(offline, { name: 'demo', run: 'abcd1234' } as any)
    )
  })
})

describe('services started before their id took their name', () => {
  it('keep the id they had for what a task that needs them caches by', async () => {
    const { api } = await loadServices('service-id-unnamed')
    // the id of 2.0.0
    const legacy = createHash('sha1')
      .update(JSON.stringify({ cwd: '.', image: 'example/app:1', volumes: [], src: [], mounts: [] }))
      .digest('hex')
    expect(getUnnamedWorkServiceId(api.data)).toEqual(legacy)
    expect(getLegacyServiceItem(api).id()).toEqual(legacy)
    expect(api.id()).not.toEqual(legacy)
  })

  function fakeDocker(containers: { [instanceId: string]: string[] }) {
    const removed: string[] = []
    const networks: string[][] = []
    const docker = {
      listContainers: async (options: { filters: { label: string[] } }) => {
        const [id] = options.filters.label
        return (containers[id.replace('hammerkit-id=', '')] ?? []).map((Id) => ({ Id }))
      },
      getContainer: (id: string) => ({ remove: async () => void removed.push(id) }),
      listNetworks: async (options: { filters: { label: string[] } }) => {
        networks.push(options.filters.label)
        return []
      },
    }
    return { docker: docker as any, removed, networks }
  }

  it('go on docker, with their network', async () => {
    const { api } = await loadServices('service-id-legacy-docker')
    const legacy = getWorkInstanceId(getLegacyServiceItem(api))
    const { docker, removed, networks } = fakeDocker({ [legacy]: ['old'], [getWorkInstanceId(api)]: ['current'] })

    await removeLegacyService(docker, api)

    expect(removed).toEqual(['old'])
    expect(networks).toEqual([[`hammerkit-network-of=${legacy}`]])
  })

  it('leave docker as it is when there are none', async () => {
    const { api } = await loadServices('service-id-legacy-docker-none')
    const { docker, removed, networks } = fakeDocker({ [getWorkInstanceId(api)]: ['current'] })

    await removeLegacyService(docker, api)

    expect(removed).toEqual([])
    expect(networks).toEqual([])
  })

  function fakeKubernetes(deployments: { [id: string]: string[] }) {
    const deleted: string[] = []
    const ofSelector = (labelSelector: string) => {
      const id = /hammerkit\.dev\/id=([0-9a-f]+)/.exec(labelSelector)?.[1]
      return id && !labelSelector.includes('network-of') ? deployments[id] ?? [] : []
    }
    const instance = {
      appsApi: {
        listNamespacedDeployment: async ({ labelSelector }: { labelSelector: string }) => ({
          items: ofSelector(labelSelector).map((name) => ({ metadata: { name } })),
        }),
        deleteNamespacedDeployment: async ({ name }: { name: string }) => void deleted.push(name),
      },
      coreApi: {
        deleteNamespacedSecret: async () => ({}),
        deleteNamespacedService: async () => ({}),
        listNamespacedPod: async () => ({ items: [] }),
      },
      objectApi: { list: async () => ({ items: [] }) },
    }
    return { instance: instance as any, deleted }
  }

  const kubernetes = { type: 'kubernetes', namespace: 'demo' } as any

  it('go on kubernetes', async () => {
    const { api } = await loadServices('service-id-legacy-kubernetes')
    const legacy = getLegacyServiceItem(api).id()
    const { instance, deleted } = fakeKubernetes({ [legacy]: ['api-old'], [api.id()]: ['api-current'] })

    await removeLegacyKubernetesService(instance, kubernetes, api)

    expect(deleted).toEqual(['api-old'])
  })

  it('leave kubernetes as it is when there are none', async () => {
    const { api } = await loadServices('service-id-legacy-kubernetes-none')
    const { instance, deleted } = fakeKubernetes({ [api.id()]: ['api-current'] })

    await removeLegacyKubernetesService(instance, kubernetes, api)

    expect(deleted).toEqual([])
  })
})
