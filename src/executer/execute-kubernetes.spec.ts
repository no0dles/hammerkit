import { getConfigMapData, getKubernetesExecutor } from './execute-kubernetes'
import { join } from 'path'
import { createWorkTree } from '../testing/create-work-tree'
import { getExecutionContextMock } from './get-execution-context-mock'
import { ContainerWorkNode } from '../planner/work-node'
import { ExecutionContextMock } from './execution-context-mock'
import { WorkTree } from '../planner/work-tree'
import { Defer } from '../utils/defer'
import { execute } from './execute'
import { ExecutionContext } from './execution-context'

describe('executor/execute-kubernetes', () => {
  const packageJsonContent = JSON.stringify({
    name: 'kubernetes',
    version: '1.0.0',
    devDependencies: {
      typescript: '^4.3.5',
    },
  })
  const indexFile = 'console.log("hello")'

  let ctx: ExecutionContextMock
  let workTree: WorkTree

  beforeEach(async () => {
    ctx = getExecutionContextMock()

    await ctx.environment.file.createDirectory(join(ctx.environment.cwd, 'src'))
    await ctx.environment.file.createDirectory(join(ctx.environment.cwd, 'node_modules'))
    await ctx.environment.file.writeFile(join(ctx.environment.cwd, 'package.json'), packageJsonContent)
    await ctx.environment.file.writeFile(join(ctx.environment.cwd, 'src/index.ts'), indexFile)
    await ctx.environment.file.writeFile(join(ctx.environment.cwd, 'node_modules', 'test.js'), '')

    workTree = await createWorkTree(
      ctx.environment,
      {
        containerRuntime: {
          type: 'kubernetes',
        },
        tasks: {
          install: {
            image: 'node',
            cmds: ['npm install'],
            src: ['package.json'],
            generates: ['node_modules'],
            mounts: ['$PWD/.npm:/.npm', '$PWD/.config:/.config'],
          },
          api: {
            image: 'node',
            deps: ['install'],
            cmds: ['node -r ts-node/register src/index.ts'],
            src: ['src'],
          },
        },
      },
      'api'
    )
  })

  it('should', async () => {
    const executionContext: ExecutionContext = { ...ctx, executor: getKubernetesExecutor() }
    const result = await execute(workTree, executionContext)
  })

  it('should ignore generated paths from configmap', async () => {
    const configMap = await getConfigMapData(workTree, workTree.rootNode as ContainerWorkNode, ctx.environment.file)
    expect(configMap).toEqual([
      {
        containerPath: '/home/user/src',
        files: { 'index-js': { content: indexFile, fileName: 'index.js' } },
        name: 'config-f790afa6be9a042a68ae2d510e42ee251ee989d8-home-user-src',
      },
      {
        containerPath: '/home/user',
        files: { 'package-json': { content: packageJsonContent, fileName: 'package.json' } },
        name: 'config-f790afa6be9a042a68ae2d510e42ee251ee989d8-home-user',
      },
    ])
  })
})
