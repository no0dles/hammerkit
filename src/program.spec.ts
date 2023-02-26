import { createTestCase } from './testing/test-case'

describe('program', () => {
  it('should run when cache is up to date and --no-cache arg is passed', async () => {
    const testCase = createTestCase('no-cache', {
      '.hammerkit.yaml': {
        tasks: {
          'package.json': '{ "dependencies": { "hammerkit": "latest" } }',
          example: {
            description: 'install npm packages',
            image: 'node:16.6.0-alpine',
            mounts: ['npm:/.npm'],
            src: ['package.json', 'package-lock.json'],
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
