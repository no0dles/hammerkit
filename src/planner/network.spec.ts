import { join } from 'path'
import { spawn } from 'child_process'
import { AddressInfo, createServer } from 'net'
import Dockerode from 'dockerode'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { Environment } from '../executer/environment'
import { WorkItem } from './work-item'
import { ContainerWorkTask } from './work-task'
import { ContainerWorkService } from './work-service'
import { ParseError } from '../schema/parse-error'
import { getServiceDefinitionHash } from './service-definition'
import { applyNetworkCeiling, getEffectiveNetwork } from './work-network'
import { getItemProxyEnvironment } from '../network/egress-proxy'
import { buildCreateOptions } from '../executer/docker-task'
import { buildServiceCreateOptions } from '../executer/docker-service'
import { getItemNetworkName, prepareItemNetwork } from '../docker/item-network'
import {
  buildNetworkPolicy,
  buildProxyPolicy,
  ensureKubernetesItemNetwork,
  getProxyName,
  getProxyReadinessScript,
  removeAllKubernetesItemNetworks,
} from '../kubernetes/network-policy'
import { ExecuteOptions } from '../runtime/runtime'
import { ServiceState } from '../executer/scheduler/service-state'
import { State } from '../executer/state'
import { WorkKubernetesEnvironment } from './work-environment'

const noSecrets = { env: {}, binds: [] }
const serviceOptions = {
  stateKey: 'state',
  daemon: false,
  publishPorts: false,
} as unknown as ExecuteOptions<ServiceState>

async function withCli(
  name: string,
  buildFile: { [key: string]: unknown },
  fn: (cli: Cli, environment: Environment) => Promise<void>
) {
  await createTestCase(name, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': buildFile,
  }).setup(async (cwd, environment) => {
    await fn(await createCli(join(cwd, '.hammerkit.yaml'), environment, {}), environment)
  })
}

async function planError(name: string, buildFile: { [key: string]: unknown }): Promise<Error> {
  try {
    await withCli(name, buildFile, async () => undefined)
  } catch (e) {
    return e as Error
  }
  throw new Error('expected an error')
}

// a running service as the run sees it, reached at a container
function runService(item: WorkItem<ContainerWorkService>, containerId: string) {
  Object.assign(item, {
    state: new State<ServiceState>({ type: 'running', stateKey: 'state', remote: null, dns: { containerId } }),
  })
}

describe('network', () => {
  describe('build file', () => {
    it('plans the network of tasks and services, open by default', async () => {
      await withCli(
        'network-plan',
        {
          services: { db: { image: 'postgres:16', network: 'none' } },
          tasks: {
            offline: { image: 'node:22', cmds: ['true'], network: 'none' },
            install: { image: 'node:22', cmds: ['true'], network: { allow: ['registry.npmjs.org'] } },
            plain: { image: 'node:22', cmds: ['true'] },
            local: { cmds: ['true'], network: 'open' },
            base: { image: 'node:22', network: 'none' },
            derived: { extend: 'base', cmds: ['true'] },
          },
        },
        async (cli) => {
          expect(cli.task('offline').data.network).toEqual({ type: 'none' })
          expect(cli.task('install').data.network).toEqual({ type: 'allow', hosts: ['registry.npmjs.org'] })
          expect(cli.task('plain').data.network).toEqual({ type: 'open' })
          expect(cli.task('local').data.network).toEqual({ type: 'open' })
          expect(cli.task('derived').data.network).toEqual({ type: 'none' })
          expect((cli.service('db').data as ContainerWorkService).network).toEqual({ type: 'none' })
        }
      )
    })

    it.each<[string, unknown, RegExp]>([
      ['network-level', 'closed', /invalid_union/],
      ['network-port', { allow: ['a.com:3128'] }, /invalid host \\"a.com:3128\\"/],
      ['network-forward-wildcard', { allow: ['*.a.com:5432'] }, /invalid host \\"\*.a.com:5432\\"/],
      ['network-forward-shared-port', { allow: ['a.com:5432', 'b.com:5432'] }, /share a port/],
      ['network-ip', { allow: ['10.0.0.1'] }, /invalid host \\"10.0.0.1\\"/],
      ['network-url', { allow: ['https://a.com'] }, /invalid host \\"https:\/\/a.com\\"/],
      ['network-unknown', { allow: [], deny: [] }, /Unrecognized key.*deny/],
    ])('rejects %s', async (name, network, message) => {
      const error = await planError(name, { tasks: { build: { image: 'node:22', cmds: ['true'], network } } })
      expect(error).toBeInstanceOf(ParseError)
      expect(JSON.stringify((error as ParseError).zod.issues)).toMatch(message)
    })

    it('refuses a limited local task', async () => {
      const error = await planError('network-local', { tasks: { build: { cmds: ['true'], network: 'none' } } })
      expect(error.message).toEqual(
        "task build: network none needs a container, hammerkit can't limit the network of a local task"
      )
    })

    it('leaves the cache identity of a task alone', async () => {
      let plainId = ''
      await withCli('network-id-plain', { tasks: { build: { image: 'node:22', cmds: ['make'] } } }, async (cli) => {
        plainId = cli.task('build').id()
      })
      await withCli(
        'network-id-limited',
        { tasks: { build: { image: 'node:22', cmds: ['make'], network: 'none' } } },
        async (cli) => {
          expect(cli.task('build').id()).toEqual(plainId)
        }
      )
    })
  })

  describe('ceiling', () => {
    it('limits every item of the run and recreates a service it limits', async () => {
      await withCli(
        'network-ceiling',
        {
          services: { db: { image: 'postgres:16' } },
          tasks: {
            open: { image: 'node:22', cmds: ['true'], needs: ['db'] },
            install: { image: 'node:22', cmds: ['true'], network: { allow: ['a.com', 'b.com'] } },
          },
        },
        async (cli) => {
          const db = cli.service('db') as WorkItem<ContainerWorkService>
          const openHash = getServiceDefinitionHash(db)
          const tree = (cli as any).workTree

          applyNetworkCeiling(tree, { type: 'allow', hosts: ['b.com', 'c.com'] })
          expect(getEffectiveNetwork(cli.task('open').data)).toEqual({ type: 'allow', hosts: ['b.com', 'c.com'] })
          expect(getEffectiveNetwork(cli.task('install').data)).toEqual({ type: 'allow', hosts: ['b.com'] })
          expect(getServiceDefinitionHash(db)).not.toEqual(openHash)

          applyNetworkCeiling(tree, { type: 'open' })
          expect(getEffectiveNetwork(cli.task('open').data)).toEqual({ type: 'open' })
          expect(getServiceDefinitionHash(db)).toEqual(openHash)
        }
      )
    })

    it("bounds the proxy's whole list, the needed services by their exact names", async () => {
      await withCli(
        'network-ceiling-proxy',
        {
          services: { db: { image: 'postgres:16' } },
          tasks: {
            install: {
              image: 'node:22',
              cmds: ['true'],
              needs: [{ name: 'database', service: 'db' }],
              network: { allow: ['a.com', 'b.com'] },
            },
          },
        },
        async (cli) => {
          applyNetworkCeiling((cli as any).workTree, { type: 'allow', hosts: ['b.com'] })
          expect(getItemProxyEnvironment(cli.task('install'))).toMatchObject({
            HAMMERKIT_ALLOW: '["b.com"]',
            HAMMERKIT_NEEDS: '["database"]',
          })
        }
      )
    })

    it('refuses a limited item that needs a service under a name that is no host name', async () => {
      const buildFile = (network: unknown) => ({
        services: { web: { image: 'node:22' } },
        tasks: {
          fetch: { image: 'node:22', cmds: ['true'], needs: [{ name: '*.com', service: 'web' }], network },
        },
      })
      const message = 'fetch: network allow b.com reaches a needed service by a host name, "*.com" is none'
      await withCli('network-need-name', buildFile({ allow: ['a.com', 'b.com'] }), async (cli) => {
        await expect(cli.runExec({ network: { type: 'allow', hosts: ['b.com'] } })).rejects.toThrow(message)
        await expect(cli.runExec()).rejects.toThrow('fetch: network allow a.com, b.com reaches a needed service by')
      })
      // an open task keeps the name; a ceiling that limits it does not
      await withCli('network-need-name-open', buildFile('open'), async (cli) => {
        expect(() => applyNetworkCeiling((cli as any).workTree, null)).not.toThrow()
        await expect(cli.runExec({ network: { type: 'allow', hosts: ['b.com'] } })).rejects.toThrow(message)
        await expect(cli.runExec({ network: { type: 'none' } })).rejects.toThrow('fetch: network none reaches')
      })
    })

    it('refuses a TCP forward under the name of a service the item needs', async () => {
      await withCli(
        'network-forward-need',
        {
          services: { db: { image: 'postgres:16' } },
          tasks: {
            migrate: { image: 'node:22', cmds: ['true'], needs: ['db'], network: { allow: ['db:5432'] } },
          },
        },
        async (cli) => {
          await expect(cli.runExec()).rejects.toThrow(
            'migrate: network allow db:5432 forwards db:5432, which is the name of a service it needs'
          )
        }
      )
    })

    it('refuses a ceiling below open with a local task in the run', async () => {
      await withCli('network-ceiling-local', { tasks: { build: { cmds: ['true'] } } }, async (cli) => {
        await expect(cli.runExec({ network: { type: 'none' } })).rejects.toThrow(
          "--network none needs every task in a container, hammerkit can't limit the network of the local task build"
        )
      })
    })
  })

  describe('docker', () => {
    it('creates an open item on the default bridge with links, as before', async () => {
      await withCli(
        'network-docker-open',
        {
          services: { db: { image: 'postgres:16' }, api: { image: 'node:22', network: 'none' } },
          tasks: { build: { image: 'node:22', cmds: ['true'], needs: ['db', { name: 'backend', service: 'api' }] } },
        },
        async (cli, environment) => {
          const build = cli.task('build') as WorkItem<ContainerWorkTask>
          runService(cli.service('db') as WorkItem<ContainerWorkService>, 'db-container')
          runService(cli.service('api') as WorkItem<ContainerWorkService>, 'api-container')
          const connect = vi.fn()
          const inspect = vi.fn().mockResolvedValue({ Name: '/api-name', HostConfig: { NetworkMode: 'api-network' } })
          const getNetwork = vi.fn().mockReturnValue({ connect })
          const docker = {
            getNetwork,
            getContainer: () => ({ inspect }),
          } as unknown as Dockerode
          const network = await prepareItemNetwork(docker, build, environment, { daemon: false })
          // the open service by a link, the limited one on its own network
          expect(network.options).toEqual({ links: ['db-container:db'], hosts: [] })
          await network.connect({ id: 'build-container' } as any)
          // the network the service's container is on, which may be of an earlier run
          expect(getNetwork).toHaveBeenCalledWith('api-network')
          expect(connect).toHaveBeenCalledWith({
            Container: 'build-container',
            EndpointConfig: { Links: ['api-name:backend'] },
          })

          const options = buildCreateOptions(build, 'state', network.options, environment, noSecrets)
          expect(options.HostConfig?.NetworkMode).toBeUndefined()
          expect(options.HostConfig?.Links).toEqual(['db-container:db'])
        }
      )
    })

    it('reaches services on the host by name', async () => {
      await withCli(
        'network-docker-host',
        { services: { db: { image: 'postgres:16' } }, tasks: { build: { image: 'node:22', needs: ['db'] } } },
        async (cli, environment) => {
          const db = cli.service('db') as any
          db.state = new State<ServiceState>({
            type: 'running',
            stateKey: 's',
            remote: null,
            dns: { host: '127.0.0.1' },
          })
          const network = await prepareItemNetwork({} as Dockerode, cli.task('build') as any, environment, {
            daemon: false,
          })
          expect(network.options).toEqual({ links: [], hosts: ['db:127.0.0.1'] })
        }
      )
    })

    it('fails when a needed service is not running', async () => {
      await withCli(
        'network-docker-not-running',
        { services: { db: { image: 'postgres:16' } }, tasks: { build: { image: 'node:22', needs: ['db'] } } },
        async (cli, environment) => {
          await expect(
            prepareItemNetwork({} as Dockerode, cli.task('build') as any, environment, { daemon: false })
          ).rejects.toThrow('service db is not running')
        }
      )
    })

    it('runs a task with network none and no needs without any network', async () => {
      await withCli(
        'network-docker-none',
        { tasks: { build: { image: 'node:22', cmds: ['true'], network: 'none' } } },
        async (cli, environment) => {
          const build = cli.task('build') as WorkItem<ContainerWorkTask>
          const network = await prepareItemNetwork({} as Dockerode, build, environment, { daemon: false })
          expect(network.options).toEqual({ mode: 'none' })
          const options = buildCreateOptions(build, 'state', network.options, environment, noSecrets)
          expect(options.HostConfig?.NetworkMode).toEqual('none')
          expect(options.HostConfig?.Links).toEqual([])
        }
      )
    })

    it('puts the proxy variables on the container, its secrets winning', async () => {
      await withCli(
        'network-docker-env',
        { services: { db: { image: 'postgres:16' } }, tasks: { build: { image: 'node:22', cmds: ['true'] } } },
        async (cli, environment) => {
          const build = cli.task('build') as WorkItem<ContainerWorkTask>
          const env = { HTTPS_PROXY: 'http://hammerkit-proxy:3128' }
          const options = buildCreateOptions(build, 'state', { mode: 'net', env }, environment, noSecrets)
          expect(options.Env).toContain('HTTPS_PROXY=http://hammerkit-proxy:3128')
          expect(options.HostConfig?.NetworkMode).toEqual('net')

          const db = cli.service('db') as WorkItem<ContainerWorkService>
          const serviceCreate = buildServiceCreateOptions(db, serviceOptions, { mode: 'net', env }, noSecrets)
          expect(serviceCreate.Env).toContain('HTTPS_PROXY=http://hammerkit-proxy:3128')
          expect(serviceCreate.HostConfig?.NetworkMode).toEqual('net')
          expect(getItemNetworkName(db)).toMatch(/^hammerkit-[0-9a-f]{40}-[0-9a-f]{8}$/)
        }
      )
    })
  })

  describe('kubernetes', () => {
    const env = {
      namespace: 'ns',
      httpRoutes: [],
      networkPolicyEnforced: false,
    } as unknown as WorkKubernetesEnvironment

    it('lets a limited task reach its needed services and proxy only, and take no connections', async () => {
      await withCli(
        'network-k8s-policy',
        {
          services: { db: { image: 'postgres:16' } },
          tasks: {
            offline: { image: 'node:22', cmds: ['true'], network: 'none' },
            test: { image: 'node:22', cmds: ['true'], network: 'none', needs: ['db'] },
            install: { image: 'node:22', cmds: ['true'], network: { allow: ['a.com'] } },
          },
        },
        async (cli) => {
          const run = { run: 'abcd1234' }
          const offline = cli.task('offline') as WorkItem<ContainerWorkTask>
          const policy = buildNetworkPolicy(env, offline, { type: 'none' }, run)
          expect(policy.metadata.namespace).toEqual('ns')
          expect(policy.metadata.name).toEqual(`hammerkit-network-${offline.id().substring(0, 32)}-abcd1234`)
          // the pods of this run only, so a concurrent run keeps its own limits
          expect(policy.spec).toEqual({
            podSelector: { matchLabels: { 'hammerkit.dev/id': offline.id(), 'hammerkit.dev/run': 'abcd1234' } },
            policyTypes: ['Ingress', 'Egress'],
            ingress: [],
            egress: [],
          })

          const test = cli.task('test') as WorkItem<ContainerWorkTask>
          expect(buildNetworkPolicy(env, test, { type: 'none' }, run).spec?.egress).toEqual([
            { to: [{ podSelector: { matchLabels: { 'hammerkit.dev/id': cli.service('db').id() } } }] },
          ])

          const install = cli.task('install') as WorkItem<ContainerWorkTask>
          const key = `${install.id().substring(0, 32)}-abcd1234`
          expect(buildNetworkPolicy(env, install, { type: 'allow', hosts: ['a.com'] }, run).spec?.egress).toEqual([
            {
              to: [{ podSelector: { matchLabels: { 'hammerkit.dev/proxy-for': key } } }],
              ports: [{ protocol: 'TCP', port: 3128 }],
            },
          ])
          // the proxy takes connections from the task's pods of this run only
          expect(buildProxyPolicy(env, install, { type: 'allow', hosts: ['a.com'] }, run).spec).toEqual({
            podSelector: { matchLabels: { 'hammerkit.dev/proxy-for': key } },
            policyTypes: ['Ingress'],
            ingress: [
              {
                _from: [
                  {
                    podSelector: { matchLabels: { 'hammerkit.dev/id': install.id(), 'hammerkit.dev/run': 'abcd1234' } },
                  },
                ],
                ports: [{ protocol: 'TCP', port: 3128 }],
              },
            ],
          })
          // a TCP forward is one more port of the proxy, both ways
          const forwarding = { type: 'allow' as const, hosts: ['a.com', 'db.example.com:5432'] }
          const ports = [
            { protocol: 'TCP', port: 3128 },
            { protocol: 'TCP', port: 5432 },
          ]
          expect(buildNetworkPolicy(env, install, forwarding, run).spec?.egress?.[0].ports).toEqual(ports)
          expect(buildProxyPolicy(env, install, forwarding, run).spec?.ingress?.[0].ports).toEqual(ports)
          // a Service name has at most 63 characters, whatever the task is called
          expect(getProxyName(install, run).length).toBeLessThanOrEqual(63)
          expect(
            getProxyName(cli.service('db') as WorkItem<ContainerWorkService>, { run: null }).length
          ).toBeLessThanOrEqual(63)
        }
      )
    })

    it('takes the proxy as ready once it listens on every port', async () => {
      const server = createServer((socket) => socket.destroy())
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      const probe = (ports: number[]) =>
        new Promise<number | null>((resolve) =>
          spawn(process.execPath, ['-e', getProxyReadinessScript(ports)]).on('exit', resolve)
        )
      try {
        expect(await probe([port])).toBe(0)
        // a forward's port that nothing listens on yet
        const closed = await new Promise<number>((resolve) => {
          const other = createServer()
          other.listen(0, '127.0.0.1', () => {
            const free = (other.address() as AddressInfo).port
            other.close(() => resolve(free))
          })
        })
        expect(await probe([port, closed])).toBe(1)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('lets a limited service take connections from what needs it, or from its route', async () => {
      await withCli(
        'network-k8s-ingress',
        {
          services: { db: { image: 'postgres:16', network: 'none' }, web: { image: 'node:22', network: 'none' } },
          tasks: {
            test: { image: 'node:22', cmds: ['true'], needs: ['db'] },
            seed: { image: 'node:22', cmds: ['echo seed'], needs: ['db'] },
          },
        },
        async (cli) => {
          const db = cli.service('db') as WorkItem<ContainerWorkService>
          const policy = buildNetworkPolicy(env, db, { type: 'none' }, { run: null })
          expect(policy.spec?.podSelector).toEqual({ matchLabels: { 'hammerkit.dev/id': db.id() } })
          expect(policy.spec?.ingress).toEqual([
            {
              _from: [
                {
                  podSelector: {
                    matchExpressions: [
                      {
                        key: 'hammerkit.dev/id',
                        operator: 'In',
                        values: [cli.task('test').id(), cli.task('seed').id()],
                      },
                    ],
                  },
                },
              ],
            },
          ])

          const web = cli.service('web') as WorkItem<ContainerWorkService>
          const routed = { ...env, httpRoutes: [{ host: 'web.local', service: 'web', gateway: 'gw' }] }
          expect(buildNetworkPolicy(routed, web, { type: 'none' }, { run: null }).spec?.ingress).toEqual([{}])
          expect(buildNetworkPolicy(env, web, { type: 'none' }, { run: null }).spec?.ingress).toEqual([])
        }
      )
    })

    it('starts a limited pod behind the gate that waits until its policy holds', async () => {
      await withCli(
        'network-k8s-gate',
        {
          tasks: {
            offline: { image: 'node:22', cmds: ['true'], network: 'none' },
            deploy: { image: 'node:22', cmds: ['true'] },
          },
        },
        async (cli) => {
          const enforced = { ...env, networkPolicyEnforced: true }
          const create = vi.fn().mockImplementation(async (spec) => spec)
          const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 404 }))
          const instance = {
            objectApi: { read: notFound, create, delete: notFound },
            appsApi: { deleteNamespacedDeployment: notFound },
            coreApi: { deleteNamespacedService: notFound },
          } as any
          const scope = { followLog: false, run: 'abcd1234' }

          const offline = await ensureKubernetesItemNetwork(instance, enforced, cli.task('offline') as any, scope)
          // the policy first, then the pod, whose first container is the gate
          expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'NetworkPolicy' }))
          expect(offline.initContainers.map((c) => c.name)).toEqual(['hammerkit-network'])
          expect(offline.initContainers[0].command?.slice(0, 2)).toEqual(['node', '-e'])

          const deploy = await ensureKubernetesItemNetwork(instance, enforced, cli.task('deploy') as any, scope)
          expect(deploy.initContainers).toEqual([])
        }
      )
    })

    it("removes an item's policies and proxies once its pods ended", async () => {
      await withCli(
        'network-k8s-remove',
        { services: { db: { image: 'postgres:16', network: { allow: ['a.com'] } } } },
        async (cli) => {
          const db = cli.service('db') as WorkItem<ContainerWorkService>
          const calls: string[] = []
          const pods = [{ status: { phase: 'Running' } }]
          const instance = {
            coreApi: {
              listNamespacedPod: vi.fn().mockImplementation(async () => {
                calls.push('list pods')
                // the pod ends after the first look
                return { items: pods.splice(0) }
              }),
              deleteNamespacedService: vi.fn().mockImplementation(async ({ name }) => calls.push(`service ${name}`)),
            },
            objectApi: {
              // the items of a list come without kind and apiVersion
              list: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'policy-a' } }] }),
              delete: vi.fn().mockImplementation(async (spec) => calls.push(`${spec.kind} ${spec.metadata.name}`)),
            },
            appsApi: {
              listNamespacedDeployment: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'proxy-a' } }] }),
              deleteNamespacedDeployment: vi
                .fn()
                .mockImplementation(async ({ name }) => calls.push(`deployment ${name}`)),
            },
          } as any
          await removeAllKubernetesItemNetworks(instance, env, db)
          expect(calls).toEqual([
            'list pods',
            'list pods',
            'NetworkPolicy policy-a',
            'deployment proxy-a',
            'service proxy-a',
          ])
          expect(instance.objectApi.delete).toHaveBeenCalledWith({
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: { name: 'policy-a', namespace: 'ns' },
          })
        }
      )
    })

    it('refuses a limited item on an environment that does not state NetworkPolicy is enforced', async () => {
      await withCli(
        'network-k8s-enforced',
        { tasks: { offline: { image: 'node:22', cmds: ['true'], network: 'none' } } },
        async (cli) => {
          const offline = cli.task('offline') as WorkItem<ContainerWorkTask>
          await expect(
            ensureKubernetesItemNetwork({} as any, env, offline, { followLog: false, run: 'abcd1234' })
          ).rejects.toThrow(
            'offline: network none needs a cluster that enforces NetworkPolicy, state it with networkPolicy: enforced on the kubernetes environment'
          )
        }
      )
    })
  })
})
