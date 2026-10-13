import { join } from 'path'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import Dockerode from 'dockerode'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { getWorkInstanceId } from '../../planner/work-instance-id'
import { WorkItem } from '../../planner/work-item'
import { WorkService } from '../../planner/work-service'
import { WorkScope } from '../../executer/work-scope'

// Shell syntax a caller may pass after --, which has to reach the container as
// text: busybox sh in the task, sh -c in front of a service's cmd.
const HOSTILE = [
  'a b',
  '-t',
  "it's",
  'x; touch pwned.txt',
  'x && touch pwned.txt',
  '$(touch pwned.txt)',
  '`touch pwned.txt`',
  'two\nlines; touch pwned.txt',
  '$HOME',
  '*',
  '',
  '\\',
  '"double"',
  '~',
  '{a,b}',
  '#c',
  'ünïcödé ✓',
  "'; touch pwned.txt; '",
]

async function containerOf(service: WorkItem<WorkService>): Promise<Dockerode.ContainerInspectInfo> {
  const docker = new Dockerode()
  const [container] = await docker.listContainers({
    filters: { label: [`hammerkit-id=${getWorkInstanceId(service)}`] },
  })
  expect(container).toBeDefined()
  return await docker.getContainer(container.Id).inspect()
}

// whether the container printed the text, within a few seconds of starting
async function logsOf(id: string, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const logs = await new Dockerode().getContainer(id).logs({ stdout: true, follow: false })
    if (logs.toString().includes(text)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

describe('task arguments in containers', () => {
  const files = {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      services: {
        api: {
          image: 'node:24-alpine',
          shell: 'sh',
          mounts: ['server.js'],
          cmd: 'node server.js',
          labels: { svc: 'api' },
        },
        exec: { image: 'node:24-alpine', mounts: ['server.js'], cmd: 'node server.js', labels: { svc: 'exec' } },
        db: {
          image: 'alpine:3.19',
          shell: 'sh',
          cmd: 'nc -lk -p 5000 -e echo ok',
          healthcheck: { cmd: 'nc -z db 5000' },
          init: 'seed',
          labels: { svc: 'db' },
        },
      },
      tasks: {
        args: { image: 'node:24-alpine', mounts: ['.'], cmds: ['node args.js'] },
        sh: { image: 'alpine:3.19', mounts: ['.'], cmds: ['sh -c'] },
        seed: { image: 'busybox:1.36', mounts: ['state:/state'], cmds: ['echo run >> /state/runs.txt'] },
      },
    },
    'args.js': `require('fs').writeFileSync('out.json', JSON.stringify(process.argv.slice(2)))\n`,
    'server.js': `console.log(JSON.stringify(process.argv.slice(2)))\nsetInterval(() => undefined, 1000)\n`,
  }

  const task = (taskName: string, values: string[]): WorkScope => ({ taskName, args: { values, services: false } })
  const service = (svc: string, values: string[]): WorkScope => ({
    filterLabels: { svc: [svc] },
    args: { values, services: true },
  })

  it(
    'hands every argument to a container task as one word of text',
    requiresLinuxContainers(async () => {
      await createTestCase('task-arguments-container', files).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, task('args', HOSTILE))
        expect((await cli.runExec()).success).toBe(true)
        expect(JSON.parse(readFileSync(join(cwd, 'out.json'), 'utf8'))).toEqual(HOSTILE)
        expect(existsSync(join(cwd, 'pwned.txt'))).toBe(false)
      })
    }),
    180000
  )

  it(
    'runs a pipeline handed to a task whose last command is sh -c',
    requiresLinuxContainers(async () => {
      await createTestCase('task-arguments-sh', files).setup(async (cwd, environment) => {
        const cli = await createCli(
          join(cwd, '.hammerkit.yaml'),
          environment,
          task('sh', ['echo hi | tr a-z A-Z > shout.txt'])
        )
        expect((await cli.runExec()).success).toBe(true)
        expect(readFileSync(join(cwd, 'shout.txt'), 'utf8')).toEqual('HI\n')
      })
    }),
    180000
  )

  it(
    'starts a service with them, and again without them on the next up',
    requiresLinuxContainers(async () => {
      await createTestCase('task-arguments-up', files).setup(async (cwd, environment) => {
        const buildFile = join(cwd, '.hammerkit.yaml')
        const withArgs = await createCli(buildFile, environment, service('api', ['--inspect', ...HOSTILE]))
        try {
          expect((await withArgs.runUp({ daemon: true })).success).toBe(true)
          const started = await containerOf(withArgs.service('api'))
          expect(started.Config.Entrypoint).toEqual(['sh', '-c'])
          expect(await logsOf(started.Id, JSON.stringify(['--inspect', ...HOSTILE]))).toBe(true)

          const without = await createCli(buildFile, environment, service('api', []))
          expect((await without.runUp({ daemon: true })).success).toBe(true)
          const restarted = await containerOf(without.service('api'))
          expect(restarted.Id).not.toEqual(started.Id)
          expect(restarted.Config.Labels['hammerkit-definition']).not.toEqual(
            started.Config.Labels['hammerkit-definition']
          )
          expect(restarted.Config.Cmd).toEqual(['node server.js'])
        } finally {
          await withArgs.runDown()
        }

        const exec = await createCli(buildFile, environment, service('exec', ['--inspect', 'a b']))
        try {
          expect((await exec.runUp({ daemon: true })).success).toBe(true)
          expect((await containerOf(exec.service('exec'))).Config.Cmd).toEqual([
            'node',
            'server.js',
            '--inspect',
            'a b',
          ])
        } finally {
          await exec.runDown()
        }
      })
    }),
    300000
  )

  it(
    'leaves a running service as it is when its init task runs with them',
    requiresLinuxContainers(async () => {
      await createTestCase('task-arguments-init', files).setup(async (cwd, environment) => {
        mkdirSync(join(cwd, 'state'), { recursive: true })
        const buildFile = join(cwd, '.hammerkit.yaml')
        const up = await createCli(buildFile, environment, { filterLabels: { svc: ['db'] } })
        try {
          expect((await up.runUp({ daemon: true })).success).toBe(true)
          const running = await containerOf(up.service('db'))

          const seed = await createCli(buildFile, environment, task('seed', ['again']))
          expect((await seed.runExec()).success).toBe(true)
          expect(readFileSync(join(cwd, 'state', 'runs.txt'), 'utf8')).toEqual('run\nrun again\n')
          expect((await containerOf(seed.service('db'))).Id).toEqual(running.Id)
        } finally {
          await up.runDown()
        }
      })
    }),
    300000
  )
})
