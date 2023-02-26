import { BuildFileSchema } from '../schema/build-file-schema'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { join } from 'path'

async function compareTasks(first: BuildFileSchema, second: BuildFileSchema, taskName: string, expectEqual: boolean) {
  const testCase = createTestCase('work-task-id', {
    'first.yaml': first,
    'second.yaml': second,
  })
  await testCase.setup(async (cwd, environment) => {
    const firstCli = await createCli(join(cwd, 'first.yaml'), environment, { taskName })
    const secondCli = await createCli(join(cwd, 'second.yaml'), environment, { taskName })
    const firstTask = firstCli.task(taskName)
    const secondTask = secondCli.task(taskName)
    if (expectEqual) {
      expect(firstTask.cacheId()).toEqual(secondTask.cacheId())
    } else {
      expect(firstTask.cacheId()).not.toEqual(secondTask.cacheId())
    }
  })
}

describe('work-cache-id', () => {
  it('should be the same for different mount order', async () => {
    await compareTasks(
      {
        tasks: {
          example: {
            image: 'node',
            mounts: ['$PWD/.npm:/.npm', '$PWD/.config:/.config'],
          },
        },
      },
      {
        tasks: {
          example: {
            image: 'node',
            mounts: ['$PWD/.config:/.config', '$PWD/.npm:/.npm'],
          },
        },
      },
      'example',
      true
    )
  })

  it('should be the same for different object key order', async () => {
    await compareTasks(
      {
        tasks: {
          example: {
            image: 'node:alpine',
            cmds: ['npm ci'],
          },
        },
      },
      {
        tasks: {
          example: {
            cmds: ['npm ci'],
            image: 'node:alpine',
          },
        },
      },
      'example',
      true
    )
  })

  it('should be the same with additional description', async () => {
    await compareTasks(
      {
        tasks: {
          example: {
            image: 'node:alpine',
            cmds: ['npm ci'],
          },
        },
      },
      {
        tasks: {
          example: {
            image: 'node:alpine',
            cmds: ['npm ci'],
            description: 'should not matter',
          },
        },
      },
      'example',
      true
    )
  })

  it('should be not be the same for different images', async () => {
    await compareTasks(
      {
        tasks: {
          example: {
            image: 'node:alpine',
          },
        },
      },
      {
        tasks: {
          example: {
            image: 'node',
          },
        },
      },
      'example',
      false
    )
  })

  it('should be not be the same for different cmd order', async () => {
    await compareTasks(
      {
        tasks: {
          example: {
            cmds: ['npm ci', 'npm run build'],
          },
        },
      },
      {
        tasks: {
          example: {
            cmds: ['npm run build', 'npm ci'],
          },
        },
      },
      'example',
      false
    )
  })

  it('should be be the same for different env key order', async () => {
    await compareTasks(
      {
        tasks: {
          example: {
            envs: {
              NODE_VERSION: '16.6.0',
              NPM_VERSION: '6.0.0',
            },
            cmds: ['npm ci', 'npm run build'],
          },
        },
      },
      {
        tasks: {
          example: {
            envs: {
              NPM_VERSION: '6.0.0',
              NODE_VERSION: '16.6.0',
            },
            cmds: ['npm ci', 'npm run build'],
          },
        },
      },
      'example',
      true
    )
  })

  it('should be be the same for deps in different order', async () => {
    await compareTasks(
      {
        tasks: {
          install: {
            cmds: ['npm install'],
          },
          build: {
            cmds: ['tsc'],
          },
          example: {
            deps: ['install', 'build'],
          },
        },
      },
      {
        tasks: {
          install: {
            cmds: ['npm install'],
          },
          build: {
            cmds: ['tsc'],
          },
          example: {
            deps: ['build', 'install'],
          },
        },
      },
      'example',
      true
    )
  })

  it('should be be the same for sources in different order', async () => {
    await compareTasks(
      {
        tasks: {
          example: {
            src: ['package.json', 'package-lock.json'],
          },
        },
      },
      {
        tasks: {
          example: {
            src: ['package-lock.json', 'package.json'],
          },
        },
      },
      'example',
      true
    )
  })
})
