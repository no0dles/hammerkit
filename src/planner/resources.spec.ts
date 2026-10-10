import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { Environment } from '../executer/environment'
import { WorkItem } from './work-item'
import { ContainerWorkTask, LocalWorkTask } from './work-task'
import { ContainerWorkService } from './work-service'
import { buildCreateOptions } from '../executer/docker-task'
import { buildServiceCreateOptions } from '../executer/docker-service'
import { getDockerResources } from '../executer/docker-resources'
import { getKubernetesResources } from '../kubernetes/container-resources'
import { getServiceDefinitionHash } from './service-definition'
import { ExecuteOptions } from '../runtime/runtime'
import { ParseError } from '../schema/parse-error'
import { ServiceState } from '../executer/scheduler/service-state'

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

async function parseError(name: string, buildFile: { [key: string]: unknown }): Promise<ParseError> {
  try {
    await withCli(name, buildFile, async () => undefined)
  } catch (e) {
    if (e instanceof ParseError) {
      return e
    }
    throw e
  }
  throw new Error('expected a parse error')
}

// Spawning local processes hangs on the hosted Windows runners (see
// execute.spec.ts), so the real run is gated off win32 like the other specs.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

function status() {
  return { write: vi.fn() } as any
}

describe('resources', () => {
  describe('build file', () => {
    it('plans cpus and memory of tasks and services', async () => {
      await withCli(
        'resources-plan',
        {
          tasks: {
            build: { image: 'node:22', cmds: ['true'], resources: { cpus: 2, memory: '512Mi' } },
            lint: { image: 'node:22', cmds: ['true'], resources: { cpus: '500m' } },
            plain: { image: 'node:22', cmds: ['true'] },
          },
          services: {
            db: { image: 'postgres:16', resources: { cpus: '1.5', memory: '1Gi' } },
          },
        },
        async (cli) => {
          expect(cli.task('build').data.resources).toEqual({ cpus: 2, memory: 512 * 1024 ** 2 })
          expect(cli.task('lint').data.resources).toEqual({ cpus: 0.5, memory: null })
          expect(cli.task('plain').data.resources).toBeNull()
          expect((cli.service('db').data as ContainerWorkService).resources).toEqual({
            cpus: 1.5,
            memory: 1024 ** 3,
          })
        }
      )
    })

    it.each<[string, { [key: string]: unknown }, RegExp]>([
      ['resources-cpus-unit', { cpus: '2 cores' }, /invalid cpus \\"2 cores\\"/],
      ['resources-cpus-zero', { cpus: 0 }, /invalid cpus \\"0\\"/],
      ['resources-cpus-precision', { cpus: '0.0005' }, /invalid cpus \\"0.0005\\"/],
      ['resources-memory-unit', { memory: '512MB' }, /invalid memory \\"512MB\\"/],
      ['resources-memory-small', { memory: '1Mi' }, /invalid memory \\"1Mi\\"/],
      // one value is the limit and the request: no separate requests to exceed it
      ['resources-requests', { requests: { cpus: 4 }, limits: { cpus: 2 } }, /Unrecognized key.*requests/],
    ])('rejects %s', async (name, resources, message) => {
      const error = await parseError(name, { tasks: { build: { image: 'node:22', cmds: ['true'], resources } } })
      expect(JSON.stringify(error.zod.issues)).toMatch(message)
    })

    it('rejects invalid resources on a local task', async () => {
      const error = await parseError('resources-local-invalid', {
        tasks: { build: { cmds: ['true'], resources: { cpus: 'many' } } },
      })
      expect(JSON.stringify(error.zod.issues)).toMatch(/invalid cpus \\"many\\"/)
    })

    it('rejects invalid resources on a service', async () => {
      const error = await parseError('resources-service-invalid', {
        services: { db: { image: 'postgres:16', resources: { memory: 'lots' } } },
      })
      expect(JSON.stringify(error.zod.issues)).toMatch(/invalid memory \\"lots\\"/)
    })
  })

  it('leaves the cache identity of a task alone', async () => {
    let plainId = ''
    await withCli(
      'resources-id-plain',
      { tasks: { build: { image: 'node:22', cmds: ['npm run build'], src: ['src'] } } },
      async (cli) => {
        plainId = cli.task('build').id()
      }
    )
    await withCli(
      'resources-id-limited',
      {
        tasks: {
          build: { image: 'node:22', cmds: ['npm run build'], src: ['src'], resources: { cpus: 2, memory: '1Gi' } },
        },
      },
      async (cli) => {
        expect(cli.task('build').id()).toEqual(plainId)
      }
    )
  })

  describe('docker', () => {
    it('limits the task container', async () => {
      await withCli(
        'resources-docker-task',
        {
          tasks: {
            build: { image: 'node:22', cmds: ['true'], resources: { cpus: '1500m', memory: '512Mi' } },
            plain: { image: 'node:22', cmds: ['true'] },
          },
        },
        async (cli, environment) => {
          const build = cli.task('build') as WorkItem<ContainerWorkTask>
          const limits = getDockerResources(build.data.resources, 8, status())
          const options = buildCreateOptions(build, 'state', {}, environment, noSecrets, limits)
          expect(options.HostConfig?.NanoCpus).toEqual(1_500_000_000)
          expect(options.HostConfig?.Memory).toEqual(512 * 1024 ** 2)

          // no resources: the host config of before
          const plain = cli.task('plain') as WorkItem<ContainerWorkTask>
          const plainLimits = getDockerResources(plain.data.resources, 8, status())
          expect(plainLimits).toEqual({})
          const plainOptions = buildCreateOptions(plain, 'state', {}, environment, noSecrets, plainLimits)
          expect(Object.keys(plainOptions.HostConfig ?? {}).sort()).toEqual(
            ['AutoRemove', 'Binds', 'ExtraHosts', 'Links'].sort()
          )
        }
      )
    })

    it('limits the service container', async () => {
      await withCli(
        'resources-docker-service',
        { services: { db: { image: 'postgres:16', resources: { cpus: 1, memory: '1Gi' } } } },
        async (cli) => {
          const db = cli.service('db') as WorkItem<ContainerWorkService>
          const limits = getDockerResources(db.data.resources, 4, status())
          const options = buildServiceCreateOptions(db, serviceOptions, { links: [], hosts: [] }, noSecrets, limits)
          expect(options.HostConfig?.NanoCpus).toEqual(1_000_000_000)
          expect(options.HostConfig?.Memory).toEqual(1024 ** 3)
        }
      )
    })

    it('warns and runs without a cpu limit beyond the host cpus', () => {
      const scoped = status()
      expect(getDockerResources({ cpus: 16, memory: 1024 ** 3 }, 4, scoped)).toEqual({ Memory: 1024 ** 3 })
      expect(scoped.write).toHaveBeenCalledWith('warn', expect.stringContaining('exceeds the 4 cpus'))
    })

    it('applies a limit of exactly the host cpus', () => {
      const scoped = status()
      expect(getDockerResources({ cpus: 4, memory: null }, 4, scoped)).toEqual({ NanoCpus: 4_000_000_000 })
      expect(scoped.write).not.toHaveBeenCalled()
    })
  })

  describe('kubernetes', () => {
    it('requests what it limits', () => {
      expect(getKubernetesResources({ cpus: 0.5, memory: 512 * 1024 ** 2 })).toEqual({
        resources: {
          requests: { cpu: '500m', memory: `${512 * 1024 ** 2}` },
          limits: { cpu: '500m', memory: `${512 * 1024 ** 2}` },
        },
      })
    })

    it('sets only what is declared', () => {
      expect(getKubernetesResources({ cpus: 2, memory: null })).toEqual({
        resources: { requests: { cpu: '2000m' }, limits: { cpu: '2000m' } },
      })
    })

    it('leaves the container spec alone without resources', () => {
      expect(getKubernetesResources(null)).toEqual({})
    })
  })

  describe('services', () => {
    it('keeps the definition of a service without resources and recreates one whose resources changed', async () => {
      const hashes: { [name: string]: string } = {}
      await withCli(
        'resources-service-definition',
        {
          services: {
            plain: { image: 'postgres:16' },
            small: { image: 'postgres:16', resources: { memory: '512Mi' } },
            large: { image: 'postgres:16', resources: { memory: '1Gi' } },
          },
        },
        async (cli) => {
          for (const name of ['plain', 'small', 'large']) {
            hashes[name] = getServiceDefinitionHash(cli.service(name) as WorkItem<ContainerWorkService>)
          }
        }
      )
      expect(new Set(Object.values(hashes)).size).toBe(3)

      await withCli(
        'resources-service-definition-plain',
        { services: { plain: { image: 'postgres:16' } } },
        async (cli) => {
          const plain = cli.service('plain') as WorkItem<ContainerWorkService>
          expect(getServiceDefinitionHash(plain)).toEqual(hashes.plain)
        }
      )
    })
  })

  describe('local task', () => {
    const buildFile = {
      tasks: { build: { cmds: ['true'], description: 'build', resources: { cpus: 2, memory: '1Gi' } } },
    }

    it('plans resources as a hint', async () => {
      await withCli('resources-local-plan', buildFile, async (cli) => {
        const build = cli.task('build') as WorkItem<LocalWorkTask>
        expect(build.data.type).toEqual('local-task')
        expect(build.data.resources).toEqual({ cpus: 2, memory: 1024 ** 3 })
      })
    })

    itExceptWindows('runs', async () => {
      await withCli('resources-local-run', buildFile, async (cli) => {
        const result = await cli.runExec()
        expect(result.success).toBe(true)
      })
    })

    it('notes that resources are not enforced', async () => {
      await withCli('resources-local-note', buildFile, async (cli) => {
        const warnings: string[] = []
        for await (const validation of cli.validate()) {
          warnings.push(validation.message)
        }
        expect(warnings).toContain('resources are not enforced for a local task')

        const plan = await cli.dryRun()
        expect(plan.entries[0].unenforcedResources).toBe(true)
      })
    })
  })
})
