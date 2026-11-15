import { existsSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'

const contexts: { dir: string; mode: number; dockerfile: string }[] = []

// a docker client that only notes the build context it is given: what is checked here
// is where the files of the image are put together, not the build itself
vi.mock('../executer/execute-docker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executer/execute-docker')>()),
  getContainerCli: () => ({
    async buildImage(source: { context: string }) {
      contexts.push({
        dir: source.context,
        mode: statSync(source.context).mode & 0o777,
        dockerfile: readFileSync(join(source.context, 'Dockerfile'), 'utf8'),
      })
      return {}
    },
    modem: {
      followProgress(_stream: unknown, done: (err: Error | null, res: unknown[]) => void) {
        done(null, [])
      },
    },
  }),
}))

describe('docker/package build directory', () => {
  it('puts the files of each image in a new private directory and removes it afterwards', async () => {
    contexts.length = 0
    const testCase = createTestCase('package-dir', {
      '.hammerkit.yaml': {
        services: {
          api: { image: 'node:24-alpine', cmd: 'node index.js', src: ['index.js'], ports: ['3000'] },
        },
      },
      'index.js': `console.log('hi')`,
    })
    await testCase.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      // twice: a second package of the same service does not reuse the first directory
      for (let i = 0; i < 2; i++) {
        await cli.package({
          registry: 'localhost:5000',
          push: false,
          overrideUser: false,
          username: null,
          password: null,
        })
      }
    })

    expect(contexts).toHaveLength(2)
    expect(contexts[0].dir).not.toBe(contexts[1].dir)
    for (const context of contexts) {
      expect(dirname(context.dir)).toBe(tmpdir())
      expect(basename(context.dir)).toMatch(/^hammerkit-package-/)
      // windows has no such mode bits, and its temp directory is the user's own
      if (process.platform !== 'win32') {
        expect(context.mode).toBe(0o700)
      }
      expect(context.dockerfile).toContain('FROM node:24-alpine')
      expect(existsSync(context.dir)).toBe(false)
    }
  })
})
