import { join } from 'path'
import Dockerode from 'dockerode'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { checkCacheState } from '../../executer/scheduler/enqueue-next'
import { getWorkInstanceId } from '../../planner/work-instance-id'

// A container task's state is recorded outside docker, so a run leaves no
// container behind and the next run still hits the cache.
describe('container task cleanup', () => {
  it(
    'removes the task container after a successful run and stays cached',
    requiresLinuxContainers(async () => {
      await createTestCase('container-cleanup', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            build: {
              image: 'alpine:3.19',
              src: ['in.txt'],
              generates: ['report'],
              cmds: ['mkdir -p report', 'cp in.txt report/in.txt'],
            },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const buildFile = join(cwd, '.hammerkit.yaml')
        const first = await createCli(buildFile, environment, { taskName: 'build' })
        await first.clean({ cache: true })
        expect((await first.runExec()).success).toBe(true)

        const second = await createCli(buildFile, environment, { taskName: 'build' })
        const task = second.task('build')
        const containers = await new Dockerode().listContainers({
          all: true,
          filters: { label: [`hammerkit-id=${getWorkInstanceId(task)}`] },
        })
        expect(containers).toEqual([])
        expect((await checkCacheState(task, 'checksum', environment)).cached).toBe(true)
      })
    })
  )
})
