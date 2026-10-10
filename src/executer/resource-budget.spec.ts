import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { ProcessManager } from './process-manager'
import { findOversizedWork, getResourceCapacity, requestsEverything, ResourceBudget } from './resource-budget'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkService } from '../planner/work-service'
import { Environment } from './environment'
import { logContext, statusConsole } from '../planner/work-item-status'
import { emptyWritable } from '../utils/empty-writable'

const GiB = 1024 ** 3
const docker = { type: 'docker' } as const

function item(name: string, cpus: number | null, memory: number | null, type = 'container-task'): WorkItem<any> {
  const requests = { cpus, memory }
  return {
    id: () => name,
    name,
    status: statusConsole(emptyWritable()).context(logContext('task', { name } as any)),
    deps: [],
    needs: [],
    requiredBy: [],
    data: { type, name, resources: cpus === null && memory === null ? null : { requests, limits: requests } },
  } as WorkItem<any>
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('resource budget', () => {
  describe('scheduling', () => {
    function manager(cpus: number, memory: number, workers = 0) {
      return new ProcessManager(
        workers,
        new ResourceBudget({ millicores: cpus * 1000, memory, source: 'test' }, docker)
      )
    }

    it('runs as many tasks at once as their requests allow, without a worker count', async () => {
      const pm = manager(8, 8 * GiB)
      const started: string[] = []
      const gates = ['a', 'b', 'c', 'd'].map(() => gate())
      const runs = ['a', 'b', 'c', 'd'].map((name, i) =>
        pm.task(item(name, 2, GiB), async () => {
          started.push(name)
          await gates[i].promise
        })
      )
      await tick()
      // 8 cpus fit four 2-cpu tasks
      expect(started.sort()).toEqual(['a', 'b', 'c', 'd'])
      gates.forEach((g) => g.open())
      await Promise.all(runs)
    })

    it('holds a task back until the running ones leave room', async () => {
      const pm = manager(4, 8 * GiB)
      const started: string[] = []
      const gates = { a: gate(), b: gate(), c: gate() }
      const runs = (['a', 'b', 'c'] as const).map((name) =>
        pm.task(item(name, 2, GiB), async () => {
          started.push(name)
          await gates[name].promise
        })
      )
      await tick()
      expect(started).toEqual(['a', 'b'])
      gates.a.open()
      await tick()
      expect(started).toEqual(['a', 'b', 'c'])
      gates.b.open()
      gates.c.open()
      await Promise.all(runs)
    })

    it('counts memory as well as cpus', async () => {
      const pm = manager(16, 3 * GiB)
      const started: string[] = []
      const gates = { a: gate(), b: gate() }
      const runs = (['a', 'b'] as const).map((name) =>
        pm.task(item(name, 1, 2 * GiB), async () => {
          started.push(name)
          await gates[name].promise
        })
      )
      await tick()
      expect(started).toEqual(['a'])
      gates.a.open()
      await tick()
      gates.b.open()
      await Promise.all(runs)
      expect(started).toEqual(['a', 'b'])
    })

    it('lets a smaller task pass one that waits for room', async () => {
      const pm = manager(4, 8 * GiB)
      const started: string[] = []
      const gates = { a: gate(), big: gate(), small: gate() }
      const runs = [
        pm.task(item('a', 3, GiB), async () => {
          started.push('a')
          await gates.a.promise
        }),
        pm.task(item('big', 3, GiB), async () => {
          started.push('big')
          await gates.big.promise
        }),
        pm.task(item('small', 1, GiB), async () => {
          started.push('small')
          await gates.small.promise
        }),
      ]
      await tick()
      expect(started).toEqual(['a', 'small'])
      gates.a.open()
      await tick()
      expect(started).toEqual(['a', 'small', 'big'])
      gates.big.open()
      gates.small.open()
      await Promise.all(runs)
    })

    it('still bounds the run by the worker count', async () => {
      const pm = manager(64, 64 * GiB, 1)
      const started: string[] = []
      const gates = { a: gate(), b: gate() }
      const runs = (['a', 'b'] as const).map((name) =>
        pm.task(item(name, 1, GiB), async () => {
          started.push(name)
          await gates[name].promise
        })
      )
      await tick()
      expect(started).toEqual(['a'])
      gates.a.open()
      gates.b.open()
      await Promise.all(runs)
    })

    it('starts a task that alone exceeds the budget when nothing else runs', async () => {
      const pm = manager(2, GiB)
      let ran = false
      await pm.task(item('huge', 8, 8 * GiB), async () => {
        ran = true
      })
      expect(ran).toBe(true)
    })

    it('makes a running service hold its requests until it ends', async () => {
      const pm = manager(4, 8 * GiB)
      const release = pm.service(item('db', 4, GiB, 'container-service') as WorkItem<WorkService>)
      const started: string[] = []
      const gates = { a: gate(), b: gate() }
      const runs = (['a', 'b'] as const).map((name) =>
        pm.task(item(name, 1, GiB), async () => {
          started.push(name)
          await gates[name].promise
        })
      )
      await tick()
      // the service fills the budget: the first task starts as the only one running, the second waits
      expect(started).toEqual(['a'])
      release()
      await tick()
      expect(started).toEqual(['a', 'b'])
      gates.a.open()
      gates.b.open()
      await Promise.all(runs)
    })

    it('does not count requests of tasks running elsewhere', () => {
      const budget = new ResourceBudget({ millicores: 1000, memory: GiB, source: 'test' }, { type: 'docker' })
      expect(budget.requestsOf(item('local', 4, 8 * GiB, 'local-task') as WorkItem<WorkTask>)).toEqual({
        millicores: 4000,
        memory: 8 * GiB,
      })
      const k8s = new ResourceBudget(
        { millicores: 1000, memory: GiB, source: 'test' },
        { type: 'kubernetes', namespace: 'n', context: 'c', httpRoutes: [] }
      )
      expect(k8s.requestsOf(item('job', 4, 8 * GiB))).toEqual({ millicores: 0, memory: 0 })
    })
  })

  describe('build file', () => {
    async function withCli(
      name: string,
      buildFile: { [key: string]: unknown },
      fn: (cli: Cli, environment: Environment) => Promise<void>,
      envs: { [key: string]: string } = {}
    ) {
      await createTestCase(name, {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': buildFile,
      }).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, ...envs }
        await fn(await createCli(join(cwd, '.hammerkit.yaml'), environment, {}), environment)
      })
    }

    const buildFile = {
      services: { db: { image: 'postgres:16', resources: { cpus: 2, memory: '4Gi' } } },
      tasks: {
        test: { image: 'node:22', needs: ['db'], cmds: ['true'], resources: { cpus: 2, memory: '1Gi' } },
        lint: { image: 'node:22', cmds: ['true'], resources: { cpus: 1, memory: '1Gi' } },
      },
    }

    it('rejects a task whose requests with its services exceed the host', async () => {
      await withCli(
        'budget-oversized',
        buildFile,
        async (cli, environment) => {
          const capacity = (await getResourceCapacity(cli['workTree'], environment))!
          expect(capacity).toMatchObject({ millicores: 3000, memory: 4 * GiB })
          const problems = findOversizedWork(cli['workTree'], capacity, false)
          expect(problems.map((p) => p.item.name)).toEqual(['test'])
          expect(problems[0].message).toMatch(/the task and the services it needs request 4 cpus, 5Gi memory/)
        },
        { HAMMERKIT_CPUS: '3', HAMMERKIT_MEMORY: '4Gi' }
      )
    })

    it('fails the run before starting anything, unless the check is skipped', async () => {
      await withCli(
        'budget-abort',
        buildFile,
        async (cli) => {
          const result = await cli.runExec({ workers: 1 })
          expect(result.success).toBe(false)
          expect(result.state.tasks['test'].state.current).toMatchObject({
            type: 'error',
            errorMessage: expect.stringContaining('--skip-resource-check'),
          })
          expect(result.state.tasks['lint'].state.current.type).toBe('pending')
        },
        { HAMMERKIT_CPUS: '3', HAMMERKIT_MEMORY: '4Gi' }
      )
    })

    it('checks the services of `up` together', async () => {
      await withCli(
        'budget-up',
        {
          services: {
            a: { image: 'x', resources: { cpus: 2, memory: '1Gi' } },
            b: { image: 'x', resources: { cpus: 2, memory: '1Gi' } },
          },
        },
        async (cli, environment) => {
          const capacity = (await getResourceCapacity(cli['workTree'], environment))!
          expect(findOversizedWork(cli['workTree'], capacity, false)).toEqual([])
          expect(findOversizedWork(cli['workTree'], capacity, true).map((p) => p.item.name)).toEqual(['a', 'b'])
        },
        { HAMMERKIT_CPUS: '3', HAMMERKIT_MEMORY: '4Gi' }
      )
    })

    it('does not look at the host when nothing requests resources', async () => {
      await withCli(
        'budget-none',
        { tasks: { build: { image: 'node:22', cmds: ['true'] } } },
        async (cli, environment) => {
          expect(await getResourceCapacity(cli['workTree'], environment)).toBeNull()
          expect(requestsEverything(cli['workTree'])).toBe(false)
          expect(cli.defaultWorkers()).toBe(4)
        }
      )
    })

    it('rejects an invalid HAMMERKIT_CPUS', async () => {
      await withCli(
        'budget-invalid-env',
        buildFile,
        async (cli, environment) => {
          await expect(getResourceCapacity(cli['workTree'], environment)).rejects.toThrow(/HAMMERKIT_CPUS/)
        },
        { HAMMERKIT_CPUS: 'many' }
      )
    })

    it('runs unbounded only when everything requests cpus and memory', async () => {
      await withCli('budget-everything', buildFile, async (cli) => {
        expect(requestsEverything(cli['workTree'])).toBe(true)
        expect(cli.defaultWorkers()).toBe(0)
      })
      await withCli(
        'budget-partial',
        { tasks: { ...buildFile.tasks, other: { image: 'node:22', cmds: ['true'] } }, services: buildFile.services },
        async (cli) => {
          expect(requestsEverything(cli['workTree'])).toBe(false)
          expect(cli.defaultWorkers()).toBe(4)
        }
      )
      await withCli(
        'budget-cpus-only',
        { tasks: { build: { image: 'node:22', cmds: ['true'], resources: { cpus: 1 } } } },
        async (cli) => {
          expect(cli.defaultWorkers()).toBe(4)
        }
      )
    })
  })
})
