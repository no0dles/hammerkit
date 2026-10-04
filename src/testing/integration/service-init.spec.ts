import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// A service's init is a task that runs once the healthcheck passed, against the
// service by name. Everything else needing the service starts only once the
// init succeeded; a failing init fails the run.
describe('service init', () => {
  const project = (initCmds: string[]) => ({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      services: {
        db: {
          image: 'alpine:3.19',
          shell: 'sh',
          cmd: 'nc -lk -p 5000 -e echo ok',
          healthcheck: { cmd: 'nc -z db 5000' },
          init: 'seed',
        },
      },
      tasks: {
        seed: { image: 'busybox:1.36', mounts: ['state:/state'], cmds: initCmds },
        test: {
          image: 'alpine:3.19',
          needs: ['db'],
          src: ['in.txt'],
          mounts: ['state:/state'],
          cmds: ['cat /state/init.txt > /state/seen-by-task.txt'],
        },
      },
    },
    'in.txt': 'hello\n',
  })
  const seed = ['nc -w 3 db 5000 < /dev/null > /state/init.txt', 'echo run >> /state/runs.txt']

  it(
    'runs the init against the service before a task needing it starts',
    requiresLinuxContainers(async () => {
      await createTestCase('service-init', project(seed)).setup(async (cwd, environment) => {
        mkdirSync(join(cwd, 'state'), { recursive: true })
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        await cli.clean({ cache: true })
        const result = await cli.runExec()
        expect(result.success).toBe(true)
        expect(result.state.tasks['seed'].state.current).toMatchObject({ type: 'completed', cached: false })
        expect(readFileSync(join(cwd, 'state', 'seen-by-task.txt'), 'utf8')).toEqual('ok\n')
        expect(readFileSync(join(cwd, 'state', 'runs.txt'), 'utf8')).toEqual('run\n')
      })
    }),
    120000
  )

  it(
    'runs the init once when it is asked for by name',
    requiresLinuxContainers(async () => {
      await createTestCase('service-init-by-name', project(seed)).setup(async (cwd, environment) => {
        mkdirSync(join(cwd, 'state'), { recursive: true })
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'seed' })
        await cli.clean({ cache: true })
        expect((await cli.runExec()).success).toBe(true)
        expect(readFileSync(join(cwd, 'state', 'runs.txt'), 'utf8')).toEqual('run\n')
      })
    }),
    120000
  )

  it(
    'skips the init for a service left running by up, unless asked for by name',
    requiresLinuxContainers(async () => {
      await createTestCase('service-init-reused', project(seed)).setup(async (cwd, environment) => {
        mkdirSync(join(cwd, 'state'), { recursive: true })
        const up = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
        await up.clean({ cache: true })
        try {
          expect((await up.runUp({ daemon: true })).success).toBe(true)
          expect(readFileSync(join(cwd, 'state', 'runs.txt'), 'utf8')).toEqual('run\n')

          const test = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
          const result = await test.runExec()
          expect(result.success).toBe(true)
          expect(result.state.tasks['seed'].state.current).toMatchObject({ type: 'completed', skipped: true })
          expect(readFileSync(join(cwd, 'state', 'runs.txt'), 'utf8')).toEqual('run\n')

          const again = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'seed' })
          expect((await again.runExec()).success).toBe(true)
          expect(readFileSync(join(cwd, 'state', 'runs.txt'), 'utf8')).toEqual('run\nrun\n')
        } finally {
          await up.runDown()
        }
      })
    }),
    180000
  )

  it(
    'fails the run and never starts a task needing the service when the init fails',
    requiresLinuxContainers(async () => {
      await createTestCase('service-init-failing', project(['exit 4'])).setup(async (cwd, environment) => {
        mkdirSync(join(cwd, 'state'), { recursive: true })
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        await cli.clean({ cache: true })
        const result = await cli.runExec()
        expect(result.success).toBe(false)
        expect(result.state.tasks['seed'].state.current).toMatchObject({ type: 'crash', exitCode: 4 })
        expect(result.state.tasks['test'].state.current.type).not.toEqual('completed')
      })
    }),
    120000
  )
})
