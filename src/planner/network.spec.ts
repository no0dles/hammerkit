import { join } from 'path'
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
import { buildCreateOptions } from '../executer/docker-task'
import { buildServiceCreateOptions } from '../executer/docker-service'
import { getItemNetworkName, prepareItemNetwork } from '../docker/item-network'
import { buildNetworkPolicy, getProxyName } from '../kubernetes/network-policy'
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
      ['network-port', { allow: ['a.com:443'] }, /invalid host \\"a.com:443\\"/],
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
          const inspect = vi.fn().mockResolvedValue({ Name: '/api-name' })
          const docker = {
            getNetwork: () => ({ connect }),
            getContainer: () => ({ inspect }),
          } as unknown as Dockerode
          const network = await prepareItemNetwork(docker, build, environment, { daemon: false })
          // the open service by a link, the limited one on its own network
          expect(network.options).toEqual({ links: ['db-container:db'], hosts: [] })
          await network.connect({ id: 'build-container' } as any)
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
          expect(getItemNetworkName(db)).toMatch(/^hammerkit-[0-9a-f]{40}$/)
        }
      )
    })
  })

  describe('kubernetes', () => {
    const env = { namespace: 'ns' } as WorkKubernetesEnvironment

    it('lets a limited item reach its needed services and proxy only', async () => {
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
          const offline = cli.task('offline') as WorkItem<ContainerWorkTask>
          const policy = buildNetworkPolicy(env, offline, { type: 'none' })
          expect(policy.metadata.namespace).toEqual('ns')
          expect(policy.spec).toEqual({
            podSelector: { matchLabels: { 'hammerkit.dev/id': offline.id() } },
            policyTypes: ['Egress'],
            egress: [],
          })

          const test = cli.task('test') as WorkItem<ContainerWorkTask>
          expect(buildNetworkPolicy(env, test, { type: 'none' }).spec?.egress).toEqual([
            { to: [{ podSelector: { matchLabels: { 'hammerkit.dev/id': cli.service('db').id() } } }] },
          ])

          const install = cli.task('install') as WorkItem<ContainerWorkTask>
          expect(buildNetworkPolicy(env, install, { type: 'allow', hosts: ['a.com'] }).spec?.egress).toEqual([
            {
              to: [{ podSelector: { matchLabels: { 'hammerkit.dev/proxy-for': install.id() } } }],
              ports: [{ protocol: 'TCP', port: 3128 }],
            },
          ])
          // a Service name has at most 63 characters, whatever the task is called
          expect(getProxyName(install).length).toBeLessThanOrEqual(63)
        }
      )
    })
  })
})
