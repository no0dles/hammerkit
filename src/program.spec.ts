import { createTestCase } from './testing/test-case'

describe('program', () => {
  it('should run when cache is up to date and --no-cache arg is passed', async () => {
    const testCase = createTestCase('no-cache', {
      'package.json': '{ "dependencies": { "hammerkit": "^1.5.0" } }',
      '.hammerkit.yaml': {
        tasks: {
          example: {
            description: 'install npm packages',
            image: 'node:16.6.0-alpine',
            // On linux hammerkit runs the container as the host uid:gid (see
            // get-container-user) so generated files aren't root-owned. That uid
            // has no home dir in the image, so npm falls back to the unwritable
            // /.npm and fails with EACCES. Point HOME at a writable dir — what a
            // real non-root user would do — so the task works regardless of uid
            // (it only "passed" elsewhere because those ran the container as root).
            envs: { HOME: '/tmp' },
            src: ['package.json'],
            generates: ['node_modules'],
            cmds: ['npm install'],
          },
        },
      },
    })
    await testCase.shell(['run', 'example', '--cache', 'none'])
  }, 120000)

  it('should warn about invalid task name', async () => {
    const testCase = createTestCase('wrong-name', {
      '.hammerkit.yaml': {
        tasks: {
          example: {
            image: 'node:16.6.0-alpine',
            cmds: ['npm ci'],
          },
        },
      },
    })
    await expect(testCase.shell(['run', 'example2'])).rejects.toThrow('No tasks found')
  })
})
