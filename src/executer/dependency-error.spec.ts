import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'

// A dependency can fail before it runs any command: here its cache check can't
// reach the Docker daemon. The task waiting for it must not wait forever. A
// run that never settles lets Node's event loop drain, and the process then
// exits 0 without output, so CI reports success for a build that never ran.
describe('a dependency failing before it runs', () => {
  const previous = process.env.DOCKER_HOST

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.DOCKER_HOST
    } else {
      process.env.DOCKER_HOST = previous
    }
  })

  it('fails the run instead of leaving its dependents waiting', async () => {
    // nothing listens on the discard port, so every Docker call fails fast
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:9'
    await createTestCase('dependency-error', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        tasks: {
          build: { image: 'alpine:3.21', src: ['input.txt'], cmds: ['cat input.txt'] },
          ci: { deps: ['build'] },
        },
      },
      'input.txt': 'x\n',
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'ci' })
      const result = await cli.runExec()
      expect(result.success).toBe(false)
      expect(result.state.tasks['build'].state.current.type).toBe('error')
      expect(result.state.tasks['ci'].state.current.type).not.toBe('completed')
    })
  }, 20000)
})
