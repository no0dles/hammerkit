import { getWorkNodeId } from './work-node-id'
import { parseBuildFile } from '../parser/parse-build-file'
import { fileContext } from '../run-arg'
import { consoleContext } from '../log'
import { Defer } from '../defer'

function createBuildFile(buildFile: any) {
  return parseBuildFile('/home/user/build.yaml', {}, buildFile, {
    cwd: process.cwd(),
    cancelDefer: new Defer<void>(),
    processEnvs: process.env,
    file: fileContext(),
    console: consoleContext(),
  })
}

async function compareTasks(firstTask: any, secondTask: any, expectEqual: boolean) {
  const firstBuildFile = await createBuildFile({
    tasks: {
      test: firstTask,
    },
  })
  const secondBuildFile = await createBuildFile({
    tasks: {
      test: secondTask,
    },
  })
  const firstNodeId = getWorkNodeId(firstBuildFile.tasks['test'])
  const secondNodeId = getWorkNodeId(secondBuildFile.tasks['test'])
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
          NODE_VERSION: '14.16.0',
          NPM_VERSION: '6.0.0',
        },
        cmds: ['npm ci', 'npm run build'],
      },
      {
        envs: {
          NPM_VERSION: '6.0.0',
          NODE_VERSION: '14.16.0',
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
