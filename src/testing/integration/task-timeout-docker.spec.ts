import Dockerode from 'dockerode'
import { join } from 'path'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { getWorkInstanceId } from '../../planner/work-instance-id'

describe('task timeout (docker)', () => {
  it(
    'aborts a container task at its timeout and removes the container',
    requiresLinuxContainers(async () => {
      await createTestCase('task-timeout-docker', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: { slow: { image: 'alpine:3.19', src: ['input.txt'], timeout: '2s', cmds: ['sleep 60'] } },
        },
        'input.txt': 'x\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'slow' })
        const started = Date.now()
        const result = await cli.runExec()
        expect(Date.now() - started).toBeLessThan(30_000)
        expect(result.state.tasks['slow'].state.current).toMatchObject({
          type: 'error',
          errorMessage: 'timed out after 2s',
        })
        const containers = await new Dockerode().listContainers({
          all: true,
          filters: { label: [`hammerkit-id=${getWorkInstanceId(cli.task('slow'))}`] },
        })
        expect(containers).toEqual([])
      })
    })
  )
})
