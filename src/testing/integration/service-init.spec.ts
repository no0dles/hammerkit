import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// A service's init runs once after its healthcheck, against the service by
// name, before anything needing the service starts; a failing init fails it.
describe('service init', () => {
  const service = (init: object) => ({
    image: 'alpine:3.19',
    shell: 'sh',
    cmd: 'nc -lk -p 5000 -e echo ok',
    healthcheck: { cmd: 'nc -z db 5000' },
    init,
  })

  it(
    'runs the init against the service before a task needing it starts',
    requiresLinuxContainers(async () => {
      await createTestCase('service-init', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            db: service({
              image: 'busybox:1.36',
              mounts: ['state:/state'],
              cmds: ['nc -w 3 db 5000 < /dev/null > /state/init.txt'],
            }),
          },
          tasks: {
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
      }).setup(async (cwd, environment) => {
        mkdirSync(join(cwd, 'state'), { recursive: true })
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        await cli.clean({ cache: true })
        expect((await cli.runExec()).success).toBe(true)
        expect(readFileSync(join(cwd, 'state', 'seen-by-task.txt'), 'utf8')).toEqual('ok\n')
      })
    }),
    120000
  )

  it(
    'fails the service and the run when the init fails',
    requiresLinuxContainers(async () => {
      await createTestCase('service-init-failing', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: { db: service({ cmds: ['exit 4'] }) },
          tasks: {
            test: { image: 'alpine:3.19', needs: ['db'], src: ['in.txt'], cmds: ['echo should not run'] },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        await cli.clean({ cache: true })
        const result = await cli.runExec()
        expect(result.success).toBe(false)
        expect(result.state.services['db'].state.current).toMatchObject({ type: 'end', reason: 'crash' })
        const messages = [...result.state.services['db'].status.read()].map((m) => m.message)
        expect(messages.join('\n')).toContain('init of db failed with exit code 4')
        expect(result.state.tasks['test'].state.current.type).not.toEqual('completed')
      })
    }),
    120000
  )
})
