import { BuildFileTaskSchema } from '../schema/build-file-task-schema'
import { getWorkNode } from '../testing/get-work-node'

async function compareTasks(firstTask: BuildFileTaskSchema, secondTask: BuildFileTaskSchema, expectEqual: boolean) {
  const firstNode = await getWorkNode(firstTask)
  const secondNode = await getWorkNode(secondTask)
  if (expectEqual) {
    expect(firstNode.id).toEqual(secondNode.id)
  } else {
    expect(firstNode.id).not.toEqual(secondNode.id)
  }
}

describe('work-node-id', () => {
  it('should be the same for different mount order', async () => {
    await compareTasks(
      {
        image: 'node',
        mounts: ['$PWD/.npm:/.npm', '$PWD/.config:/.config'],
      },
      {
        image: 'node',
        mounts: ['$PWD/.config:/.config', '$PWD/.npm:/.npm'],
      },
      true
    )
  })

  it('should be the same for different object key order', async () => {
    await compareTasks(
      {
        image: 'node:alpine',
        cmds: ['npm ci'],
      },
      {
        cmds: ['npm ci'],
        image: 'node:alpine',
      },
      true
    )
  })

  it('should be the same with additional description', async () => {
    await compareTasks(
      {
        image: 'node:alpine',
        cmds: ['npm ci'],
      },
      {
        image: 'node:alpine',
        cmds: ['npm ci'],
        description: 'should not matter',
      },
      true
    )
  })

  it('should be not be the same for different images', async () => {
    await compareTasks(
      {
        image: 'node:alpine',
      },
      {
        image: 'node',
      },
      false
    )
  })

  it('should be not be the same for different cmd order', async () => {
    await compareTasks(
      {
        cmds: ['npm ci', 'npm run build'],
      },
      {
        cmds: ['npm run build', 'npm ci'],
      },
      false
    )
  })

  it('should be be the same for different env key order', async () => {
    await compareTasks(
      {
        envs: {
          NODE_VERSION: '16.6.0',
          NPM_VERSION: '6.0.0',
        },
        cmds: ['npm ci', 'npm run build'],
      },
      {
        envs: {
          NPM_VERSION: '6.0.0',
          NODE_VERSION: '16.6.0',
        },
        cmds: ['npm ci', 'npm run build'],
      },
      true
    )
  })

  it('should be be the same for deps in different order', async () => {
    await compareTasks(
      {
        deps: ['install', 'build'],
      },
      {
        deps: ['build', 'install'],
      },
      true
    )
  })

  it('should be be the same for sources in different order', async () => {
    await compareTasks(
      {
        src: ['package.json', 'package-lock.json'],
      },
      {
        src: ['package-lock.json', 'package.json'],
      },
      true
    )
  })
})
