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
import { getItemNetworkName, getRunNetworkName, prepareItemNetwork } from '../docker/item-network'
import {
  buildNetworkPolicy,
  buildProxyPolicy,
  ensureKubernetesItemNetwork,
  getNetworkLabels,
  getNetworkPolicyName,
  getProxyName,
  getProxyReadinessScript,
  KubernetesNetworkScope,
  releaseKubernetesItemNetwork,
  removeAllKubernetesItemNetworks,
} from '../kubernetes/network-policy'
import { getRunLabelValue } from '../kubernetes/job-placement'
import { ExecuteOptions } from '../runtime/runtime'
import { ServiceState } from '../executer/scheduler/service-state'
import { State } from '../executer/state'
import { WorkKubernetesEnvironment, WorkKubernetesServer } from './work-environment'
import { WorkSecret } from './work-secret'
import { getJobSecretSpec, splitJobSecrets } from '../kubernetes/job-secrets'
import { getTaskJobContainers } from './work-runtime-kubernetes'

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

    it('refuses two TCP forwards on one port that a ceiling leaves from both lists', async () => {
      await withCli(
        'network-ceiling-shared-port',
        {
          tasks: {
            migrate: { image: 'node:22', cmds: ['true'], network: { allow: ['a.corp.com:5432', '*.corp.com'] } },
          },
        },
        async (cli) => {
          await expect(
            cli.runExec({ network: { type: 'allow', hosts: ['*.corp.com', 'b.corp.com:5432'] } })
          ).rejects.toThrow(
            'migrate: network allow *.corp.com, a.corp.com:5432, b.corp.com:5432 under --network allow *.corp.com, ' +
              'b.corp.com:5432, a.corp.com:5432 and b.corp.com:5432 share a port, each TCP forward needs its own'
          )
        }
      )
    })

    it('passes the entries a ceiling allows only through a pattern to the proxy', async () => {
      await withCli(
        'network-ceiling-public-only',
        {
          tasks: {
            migrate: { image: 'node:22', cmds: ['true'], network: { allow: ['vault.corp.com:8200', 'api.corp.com'] } },
          },
        },
        async (cli) => {
          applyNetworkCeiling((cli as any).workTree, { type: 'allow', hosts: ['*.corp.com', 'api.corp.com'] })
          expect(getItemProxyEnvironment(cli.task('migrate'))).toMatchObject({
            HAMMERKIT_ALLOW: '["api.corp.com","vault.corp.com:8200"]',
            HAMMERKIT_PUBLIC_ONLY: '["vault.corp.com:8200"]',
          })
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

    it("puts the open items of a server's run on the run's own network, not the default bridge", async () => {
      await withCli(
        'network-docker-hosted-open',
        {
          services: { db: { image: 'postgres:16' } },
          tasks: { build: { image: 'node:22', cmds: ['true'], needs: [{ name: 'database', service: 'db' }] } },
        },
        async (cli, environment) => {
          const hosted = { ...environment, hosted: { catalog: {} as any } }
          const build = cli.task('build') as WorkItem<ContainerWorkTask>
          runService(cli.service('db') as WorkItem<ContainerWorkService>, 'db-container')
          const run = getRunNetworkName()
          const created: string[] = []
          const removed: string[] = []
          const docker = {
            version: vi.fn().mockResolvedValue({ Version: '28.0.0', Os: 'linux' }),
            createNetwork: vi.fn(async ({ Name }: { Name: string }) => {
              created.push(Name)
            }),
            listContainers: vi.fn().mockResolvedValue([]),
            getNetwork: (name: string) => ({
              inspect: async () => {
                if (removed.includes(name) || !created.includes(name)) {
                  throw Object.assign(new Error('not found'), { statusCode: 404 })
                }
                return { Containers: {} }
              },
              remove: async () => {
                removed.push(name)
              },
            }),
            getContainer: () => ({
              inspect: async () => ({
                Name: '/db-name',
                HostConfig: { NetworkMode: run },
                NetworkSettings: { Networks: { [run]: { IPAddress: '172.30.0.2' } } },
              }),
            }),
          } as unknown as Dockerode

          const service = await prepareItemNetwork(docker, cli.service('db') as any, hosted, { daemon: false })
          const task = await prepareItemNetwork(docker, build, hosted, { daemon: false })
          // one network for the run, made once; the service is found by the name the task needs it by
          expect(created).toEqual([run])
          expect(service.options).toEqual({ mode: run, hosts: [] })
          expect(task.options).toEqual({ mode: run, hosts: ['database:172.30.0.2'] })
          const options = buildCreateOptions(build, 'state', task.options, hosted, noSecrets)
          expect(options.HostConfig?.NetworkMode).toEqual(run)
          expect(options.HostConfig?.Links).toEqual([])

          // removed after its last user, and made again by the next
          await task.release()
          expect(removed).toEqual([])
          await service.release()
          expect(removed).toEqual([run])
          const next = await prepareItemNetwork(docker, cli.service('db') as any, hosted, { daemon: false })
          expect(created).toEqual([run, run])
          await next.release()

          // a daemon outlives the run and stays on the default bridge, as off a server
          const daemon = await prepareItemNetwork(docker, cli.service('db') as any, hosted, { daemon: true })
          expect(daemon.options).toEqual({ links: [], hosts: [] })
        }
      )
    })

    it('keeps the open items of a server on the default bridge on a daemon without Linux bridges', async () => {
      await withCli(
        'network-docker-hosted-windows',
        { services: { db: { image: 'postgres:16' } } },
        async (cli, environment) => {
          const docker = {
            version: vi.fn().mockResolvedValue({ Version: '28.0.0', Os: 'windows' }),
          } as unknown as Dockerode
          const hosted = { ...environment, hosted: { catalog: {} as any } }
          const network = await prepareItemNetwork(docker, cli.service('db') as any, hosted, { daemon: false })
          expect(network.options).toEqual({ links: [], hosts: [] })
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

    it('labels the limits of a server run with its run, and its limited pods and proxies', async () => {
      await withCli(
        'network-k8s-server',
        {
          tasks: {
            offline: { image: 'node:22', cmds: ['true'], network: 'none' },
            install: { image: 'node:22', cmds: ['true'], network: { allow: ['a.com'] } },
            open: { image: 'node:22', cmds: ['true'] },
          },
        },
        async (cli) => {
          const server = { run: 'run_1', namespace: 'hammerkit', pools: [], providers: {}, accounts: {} }
          const run = { run: getRunLabelValue('run_1') }
          const offline = cli.task('offline') as WorkItem<ContainerWorkTask>
          const policy = buildNetworkPolicy({ ...env, server }, offline, { type: 'none' }, run)
          // removed with the run's other objects
          expect(policy.metadata.labels).toEqual({
            'hammerkit.dev/network-of': offline.id(),
            'hammerkit.dev/run': getRunLabelValue('run_1'),
          })
          expect(policy.spec?.podSelector).toEqual({
            matchLabels: { 'hammerkit.dev/id': offline.id(), 'hammerkit.dev/run': getRunLabelValue('run_1') },
          })
          // a server's run label is longer than a run id of the CLI
          const install = cli.task('install') as WorkItem<ContainerWorkTask>
          expect(getProxyName(install, run).length).toBeLessThanOrEqual(63)
          // the namespace's default policies leave limited pods out
          expect(getNetworkLabels({ ...env, server }, offline)).toEqual({ 'hammerkit.dev/network': 'limited' })
          expect(getNetworkLabels({ ...env, server }, cli.task('open') as WorkItem<ContainerWorkTask>)).toEqual({})
          expect(getNetworkLabels(env, offline)).toEqual({})
        }
      )
    })

    it('keeps the limits of a service and of what needs it within the run on a server', async () => {
      // two runs of a caller (two sandboxes of a repository) share their namespace and run
      // the same service and task side by side
      await withCli(
        'network-k8s-server-runs',
        {
          services: { db: { image: 'postgres:16', network: 'none' } },
          tasks: { test: { image: 'node:22', cmds: ['true'], network: 'none', needs: ['db'] } },
        },
        async (cli) => {
          const server = (run: string) => ({ run, namespace: 'hammerkit', pools: [], providers: {}, accounts: {} })
          const db = cli.service('db') as WorkItem<ContainerWorkService>
          const test = cli.task('test') as WorkItem<ContainerWorkTask>
          const policies = ['run_1', 'run_2'].map((id) =>
            buildNetworkPolicy({ ...env, server: server(id) }, db, { type: 'none' }, { run: getRunLabelValue(id) })
          )
          expect(policies[0].metadata.name).not.toEqual(policies[1].metadata.name)
          const label = getRunLabelValue('run_1')
          expect(policies[0].spec?.podSelector).toEqual({
            matchLabels: { 'hammerkit.dev/id': db.id(), 'hammerkit.dev/run': label },
          })
          expect(policies[0].spec?.ingress).toEqual([
            {
              _from: [
                {
                  podSelector: {
                    matchExpressions: [{ key: 'hammerkit.dev/id', operator: 'In', values: [test.id()] }],
                    matchLabels: { 'hammerkit.dev/run': label },
                  },
                },
              ],
            },
          ])
          // the task reaches the service of its own run
          expect(
            buildNetworkPolicy({ ...env, server: server('run_1') }, test, { type: 'none' }, { run: label }).spec?.egress
          ).toEqual([
            { to: [{ podSelector: { matchLabels: { 'hammerkit.dev/id': db.id(), 'hammerkit.dev/run': label } } }] },
          ])
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
            coreApi: { deleteNamespacedService: notFound, deleteNamespacedSecret: notFound },
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
              deleteNamespacedSecret: vi.fn().mockImplementation(async ({ name }) => calls.push(`secret ${name}`)),
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
            'secret proxy-a',
          ])
          expect(instance.objectApi.delete).toHaveBeenCalledWith({
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: { name: 'policy-a', namespace: 'ns' },
          })

          // on a server, those of its run only: another run's pods keep their limits
          const server = { run: 'run_1', namespace: 'hammerkit', pools: [], providers: {}, accounts: {} }
          await removeAllKubernetesItemNetworks(instance, { ...env, server }, db)
          const label = getRunLabelValue('run_1')
          expect(instance.coreApi.listNamespacedPod).toHaveBeenLastCalledWith({
            namespace: 'ns',
            labelSelector: `hammerkit.dev/id=${db.id()},hammerkit.dev/run=${label}`,
          })
          expect(instance.objectApi.list.mock.lastCall[7]).toEqual(
            `hammerkit.dev/network-of=${db.id()},hammerkit.dev/run=${label}`
          )
          expect(instance.appsApi.listNamespacedDeployment).toHaveBeenLastCalledWith({
            namespace: 'ns',
            labelSelector: `hammerkit.dev/network-of=${db.id()},hammerkit.dev/run=${label}`,
          })
        }
      )
    })

    // A cluster in memory: objects by kind and name, a Service gets an address, a
    // Deployment is ready, and the pod of a sandbox's files is there as `files`.
    function memoryCluster() {
      const objects = new Map<string, any>()
      const made: string[] = []
      const files = { metadata: { name: 'files', uid: 'pod-1' } as { name: string; uid: string } }
      const notFound = () => Object.assign(new Error('not found'), { code: 404 })
      const keyOf = (kind: string, name: string) => `${kind}/${name}`
      const remove = (kind: string, name: string) => {
        if (!objects.delete(keyOf(kind, name))) {
          throw notFound()
        }
      }
      const instance = {
        objectApi: {
          read: async (spec: any) => objects.get(keyOf(spec.kind, spec.metadata.name)) ?? Promise.reject(notFound()),
          create: async (spec: any) => {
            made.push(keyOf(spec.kind, spec.metadata.name))
            const object = {
              ...spec,
              metadata: { ...spec.metadata, uid: `uid-${made.length}` },
              spec: spec.kind === 'Service' ? { ...spec.spec, clusterIP: '10.0.0.9' } : spec.spec,
            }
            objects.set(keyOf(spec.kind, spec.metadata.name), object)
            return object
          },
          // a merge patch: what the patch leaves out stays
          patch: async (spec: any) => {
            const current = objects.get(keyOf(spec.kind, spec.metadata.name))
            const object = {
              ...current,
              metadata: { ...current.metadata, ...spec.metadata },
              spec: { ...current.spec, ...spec.spec },
            }
            objects.set(keyOf(spec.kind, spec.metadata.name), object)
            return object
          },
          delete: async (spec: any) => remove(spec.kind, spec.metadata.name),
        },
        appsApi: {
          readNamespacedDeployment: async () => ({ status: { readyReplicas: 1 } }),
          listNamespacedDeployment: async ({ labelSelector }: any) => ({
            items: [...objects.values()].filter(
              (object) =>
                object.kind === 'Deployment' &&
                labelSelector
                  .split(',')
                  .every((term: string) => object.metadata.labels?.[term.split('=')[0]] === term.split('=')[1])
            ),
          }),
          deleteNamespacedDeployment: async ({ name }: any) => remove('Deployment', name),
        },
        coreApi: {
          deleteNamespacedService: async ({ name }: any) => remove('Service', name),
          deleteNamespacedSecret: async ({ name }: any) => remove('Secret', name),
          readNamespacedPod: async ({ name }: any) =>
            name === files.metadata.name ? files : Promise.reject(notFound()),
          // the pods of a run ended
          listNamespacedPod: async () => ({ items: [] }),
        },
      } as any
      const of = (kind: string) => [...objects.values()].filter((object) => object.kind === kind)
      return { instance, objects, made, files, of }
    }

    it('keeps the proxy of a task on a sandbox for its next runs, as long as the pod of its files', async () => {
      await withCli(
        'network-k8s-sandbox-proxy',
        { tasks: { install: { image: 'node:22', cmds: ['true'], network: { allow: ['a.com'] } } } },
        async (cli) => {
          const cluster = memoryCluster()
          const pool = { name: 'build', platform: { os: 'linux', arch: 'amd64' }, nodeSelector: {}, tolerations: [] }
          const onServer = (run: string) =>
            ({
              ...env,
              networkPolicyEnforced: true,
              server: { run, namespace: 'hammerkit', pools: [pool], providers: {}, accounts: {} },
            }) as WorkKubernetesEnvironment
          const sandbox = { label: 'sbx', pod: { name: 'files', uid: 'pod-1' } }
          const scopeOf = (run: string): KubernetesNetworkScope => ({ run: getRunLabelValue(run), sandbox })
          const install = cli.task('install') as WorkItem<ContainerWorkTask>
          const runOn = async (run: string, item = install, scope = scopeOf(run)) => {
            const network = await ensureKubernetesItemNetwork(cluster.instance, onServer(run), item, {
              followLog: false,
              ...scope,
            })
            const seen = {
              deployments: cluster.of('Deployment').map((d) => ({ ...d.metadata })),
              policies: cluster.of('NetworkPolicy').map((p) => ({ name: p.metadata.name, spec: p.spec })),
              hostAliases: network.hostAliases,
            }
            network.close()
            await releaseKubernetesItemNetwork(cluster.instance, onServer(run), item, scope)
            return seen
          }

          const first = await runOn('run_1')
          expect(first.deployments).toHaveLength(1)
          const proxy = first.deployments[0]
          expect(proxy.name.length).toBeLessThanOrEqual(63)
          // no run's label: removed with the pod of the sandbox's files, which owns it
          expect(proxy.labels).toEqual({
            'hammerkit.dev/proxy-for': proxy.name.replace('hammerkit-proxy-', ''),
            'hammerkit.dev/network-of': install.id(),
            'hammerkit.dev/proxy-of-sandbox': 'sbx',
          })
          expect(proxy.ownerReferences).toEqual([{ apiVersion: 'v1', kind: 'Pod', name: 'files', uid: 'pod-1' }])
          const template = cluster.objects.get(`Deployment/${proxy.name}`).spec.template.metadata.labels
          expect(template).not.toHaveProperty('hammerkit.dev/run')
          expect(first.hostAliases).toContainEqual({ ip: '10.0.0.9', hostnames: ['hammerkit-proxy'] })
          // the run's own policy reaches it, and goes with the run; the proxy stays
          const runPolicy = first.policies.find((p) => p.name.startsWith('hammerkit-network-'))
          expect(runPolicy?.spec.egress[0].to).toEqual([
            { podSelector: { matchLabels: { 'hammerkit.dev/proxy-for': proxy.labels['hammerkit.dev/proxy-for'] } } },
          ])
          expect(cluster.of('NetworkPolicy').map((p) => p.metadata.name)).toEqual([proxy.name])
          expect(cluster.of('Deployment').map((d) => d.metadata.uid)).toEqual([proxy.uid])

          // the next run takes it as it is, and lets in the pods of that run only
          const madeBefore = cluster.made.length
          const second = await runOn('run_2')
          expect(cluster.made.slice(madeBefore)).toEqual([expect.stringMatching(/^NetworkPolicy\/hammerkit-network-/)])
          expect(second.deployments.map((d) => d.uid)).toEqual([proxy.uid])
          expect(cluster.objects.get(`NetworkPolicy/${proxy.name}`).spec.ingress[0]._from).toEqual([
            {
              podSelector: {
                matchLabels: { 'hammerkit.dev/id': install.id(), 'hammerkit.dev/run': getRunLabelValue('run_2') },
              },
            },
          ])

          // a changed allow list is a proxy of its own, and the one before goes
          install.data.network = { type: 'allow', hosts: ['b.com'] }
          const changed = await runOn('run_3')
          expect(changed.deployments).toHaveLength(1)
          expect(changed.deployments[0].name).not.toEqual(proxy.name)
          expect(cluster.objects.has(`Service/${proxy.name}`)).toBe(false)
          expect(cluster.objects.has(`NetworkPolicy/${proxy.name}`)).toBe(false)

          // the pod of the files is no longer the one the run holds (it made way for a
          // pod of the run): the proxy goes with the run
          cluster.files.metadata = { name: 'files', uid: 'pod-2' }
          await runOn('run_4')
          expect(cluster.of('Deployment')).toEqual([])
          expect(cluster.of('Service')).toEqual([])
          expect(cluster.of('NetworkPolicy')).toEqual([])

          // and a run that knows no pod of the files keeps none either
          await runOn('run_5', install, { run: getRunLabelValue('run_5'), sandbox: { label: 'sbx' } })
          expect(cluster.of('Deployment')).toEqual([])

          // a network without proxy takes the sandbox's proxy of the task away
          cluster.files.metadata = { name: 'files', uid: 'pod-1' }
          await runOn('run_6')
          expect(cluster.of('Deployment')).toHaveLength(1)
          install.data.network = { type: 'none' }
          await runOn('run_7')
          expect(cluster.of('Deployment')).toEqual([])
          expect(cluster.of('NetworkPolicy')).toEqual([])
        }
      )
    })

    it('starts a proxy per run for a task that is not on a sandbox, as before', async () => {
      await withCli(
        'network-k8s-run-proxy',
        { tasks: { install: { image: 'node:22', cmds: ['true'], network: { allow: ['a.com'] } } } },
        async (cli) => {
          const cluster = memoryCluster()
          const enforced = { ...env, networkPolicyEnforced: true }
          const install = cli.task('install') as WorkItem<ContainerWorkTask>
          const scope = { run: 'abcd1234' }
          const network = await ensureKubernetesItemNetwork(cluster.instance, enforced, install, {
            followLog: false,
            ...scope,
          })
          expect(cluster.of('Deployment').map((d) => d.metadata.name)).toEqual([getProxyName(install, scope)])
          expect(cluster.of('Deployment')[0].metadata.ownerReferences).toBeUndefined()
          network.close()
          await releaseKubernetesItemNetwork(cluster.instance, enforced, install, scope)
          expect(cluster.objects.size).toBe(0)
        }
      )
    })

    it('gives a task that reads secrets a proxy that lets only the holders of its token reach the provider', async () => {
      await withCli(
        'network-k8s-secret-proxy',
        { tasks: { deploy: { image: 'node:22', cmds: ['true'], network: 'none' } } },
        async (cli) => {
          const cluster = memoryCluster()
          const enforced = { ...env, networkPolicyEnforced: true }
          const deploy = cli.task('deploy') as WorkItem<ContainerWorkTask>
          const scope = { run: 'abcd1234' }
          const network = await ensureKubernetesItemNetwork(cluster.instance, enforced, deploy, {
            followLog: false,
            secretHosts: ['secretmanager.googleapis.com', 'sts.googleapis.com'],
            ...scope,
          })
          const name = getProxyName(deploy, scope)
          // under none the task's own container gets no proxy variables, the proxy allows it no host
          expect(network.env).toEqual([])
          const proxy = cluster.of('Deployment')[0].spec.template.spec.containers[0]
          expect(proxy.env).toEqual(
            expect.arrayContaining([
              { name: 'HAMMERKIT_ALLOW', value: '[]' },
              { name: 'HAMMERKIT_SECRET_ALLOW', value: '["secretmanager.googleapis.com","sts.googleapis.com"]' },
              { name: 'HAMMERKIT_SECRET_TOKEN', valueFrom: { secretKeyRef: { name, key: 'token' } } },
            ])
          )
          // the token is new for the run, and the init containers that read secrets read it from the Secret
          const token = Buffer.from(cluster.objects.get(`Secret/${name}`).data.token, 'base64').toString()
          expect(token).toMatch(/^[0-9a-f]{64}$/)
          expect(network.secretEnv).toEqual(
            expect.arrayContaining([
              { name: 'HAMMERKIT_PROXY_TOKEN', valueFrom: { secretKeyRef: { name, key: 'token' } } },
              { name: 'HTTPS_PROXY', value: 'http://hammerkit:$(HAMMERKIT_PROXY_TOKEN)@hammerkit-proxy:3128' },
            ])
          )
          expect(network.hostAliases).toEqual([{ ip: '10.0.0.9', hostnames: ['hammerkit-proxy'] }])
          // the pod reaches the proxy, nothing else
          const policy = cluster.objects.get(`NetworkPolicy/${getNetworkPolicyName(deploy, scope)}`)
          expect(policy.spec.egress).toEqual([
            {
              to: [{ podSelector: { matchLabels: { 'hammerkit.dev/proxy-for': expect.any(String) } } }],
              ports: [{ protocol: 'TCP', port: 3128 }],
            },
          ])
          network.close()
          await releaseKubernetesItemNetwork(cluster.instance, enforced, deploy, scope)
          // the token goes with the proxy
          expect(cluster.objects.size).toBe(0)
        }
      )
    })

    it('puts the token into the init containers that read secrets, never into the command of the task', async () => {
      await withCli(
        'network-k8s-secret-job',
        { tasks: { deploy: { image: 'node:22', cmds: ['./deploy.sh'], network: { allow: ['a.com'] } } } },
        async (cli, environment) => {
          const cluster = memoryCluster()
          const enforced = { ...env, networkPolicyEnforced: true }
          const deploy = cli.task('deploy') as WorkItem<ContainerWorkTask>
          const scope = { run: 'abcd1234' }
          const network = await ensureKubernetesItemNetwork(cluster.instance, enforced, deploy, {
            followLog: false,
            secretHosts: ['secretmanager.googleapis.com'],
            ...scope,
          })
          const name = getProxyName(deploy, scope)
          // under allow the task's container reaches the proxy, without the token
          expect(network.env).toEqual(
            expect.arrayContaining([{ name: 'HTTPS_PROXY', value: 'http://hammerkit-proxy:3128' }])
          )
          expect(network.env.filter((e) => e.valueFrom || e.value?.includes('@'))).toEqual([])

          const server: WorkKubernetesServer = {
            run: 'run_1',
            namespace: 'hammerkit',
            pools: [],
            providers: { gsm: { image: 'gcloud:slim', allow: ['secretmanager.googleapis.com'] } },
            accounts: { dev: { serviceAccount: 'dev' } },
          }
          const secret: WorkSecret = {
            source: {
              type: 'provider',
              provider: 'gsm',
              ref: 'api-key',
              account: 'dev',
              binding: {
                definition: {
                  name: 'gsm',
                  type: 'command',
                  command: ['gcloud', 'secrets', 'versions', 'access', 'latest', '--secret={{ref}}'],
                  env: {},
                  timeoutMs: 1000,
                  declaredIn: 'the server config',
                },
                account: { name: 'dev', env: {} },
              },
            },
            target: { type: 'env', name: 'API_KEY' },
            cache: false,
            digest: () => '',
          }
          const { inJob } = splitJobSecrets([secret], server)
          const credentials = { dev: [{ key: 'dev.token', path: 'token' }] }
          const secretSpec = getJobSecretSpec(deploy, inJob, server, credentials, environment, network.secretEnv)
          const pod = getTaskJobContainers({
            task: deploy,
            cmd: deploy.data.cmds[0],
            container: 'cmd-1',
            envs: {},
            secrets: { env: [], mounts: [] },
            network,
            secretSpec,
            mounts: [],
            kubernetes: enforced,
          })
          const reader = pod.initContainers?.find((c) => c.name === 'secret-0')
          expect(reader?.env).toEqual(
            expect.arrayContaining([
              { name: 'HAMMERKIT_PROXY_TOKEN', valueFrom: { secretKeyRef: { name, key: 'token' } } },
              { name: 'HTTPS_PROXY', value: 'http://hammerkit:$(HAMMERKIT_PROXY_TOKEN)@hammerkit-proxy:3128' },
            ])
          )
          expect(pod.containers).toHaveLength(1)
          const task = JSON.stringify(pod.containers[0])
          expect(task).not.toContain('HAMMERKIT_PROXY_TOKEN')
          expect(task).not.toContain(name)
          expect(task).not.toContain('secretKeyRef')
          expect(pod.containers[0].env).toEqual(expect.arrayContaining(network.env))
          network.close()
          await releaseKubernetesItemNetwork(cluster.instance, enforced, deploy, scope)
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
