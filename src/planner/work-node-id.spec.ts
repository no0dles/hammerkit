import { getWorkNodeId } from './work-node-id'
import { createBuildFile } from '../testing/create-build-file'
import { createWorkContext } from './work-context'
import { environmentMock } from '../executer/environment-mock'
import { findBuildTask } from './utils/find-build-value'
import { planTask } from './utils/plan-task'

async function compareTasks(firstTask: any, secondTask: any, expectEqual: boolean) {
  const environment = environmentMock(process.cwd())
  const firstBuildFile = await createBuildFile(environment, {
    tasks: {
      test: firstTask,
    },
  })
  const secondBuildFile = await createBuildFile(environment, {
    tasks: {
      test: secondTask,
    },
  })
  const firstContext = createWorkContext(firstBuildFile)
  const firstMerged = planTask(firstContext, findBuildTask(firstContext, { name: 'test' }))
  const secondContext = createWorkContext(secondBuildFile)
  const secondMerged = planTask(secondContext, findBuildTask(secondContext, { name: 'test' }))
  const firstNodeId = getWorkNodeId(firstMerged)
  const secondNodeId = getWorkNodeId(secondMerged)
  if (expectEqual) {
    expect(firstNodeId).toEqual(secondNodeId)
  } else {
    expect(firstNodeId).not.toEqual(secondNodeId)
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
