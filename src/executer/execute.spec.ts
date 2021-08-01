import { createWorkTree } from '../testing/create-work-tree'
import { execute } from './execute'
import { getExecutionContextMock } from './get-execution-context-mock'
import { ExecutionContextMock } from './execution-context-mock'
import { WorkTree } from '../planner/work-tree'

describe('execute', () => {
  let ctx: ExecutionContextMock
  let workTree: WorkTree
  let nodeId: string

  beforeEach(async () => {
    ctx = getExecutionContextMock()
    ctx.watch = true

    workTree = await createWorkTree(
      ctx.environment,
      {
        tasks: {
          api: {
            cmds: ['node index.js'],
            src: ['index.js', 'package.json'],
          },
        },
      },
      'api'
    )
    nodeId = workTree.rootNode.id

    await ctx.environment.file.createDirectory(ctx.environment.cwd)
    await ctx.environment.file.writeFile(`${ctx.environment.cwd}/index.js`, "console.log('hello')")
    await ctx.environment.file.writeFile(`${ctx.environment.cwd}/package.json`, '{}')
  })

  it('should restart watching task if once completed', async () => {
    const resultPromise = execute(workTree, ctx)

    const runningApi = await ctx.executor.waitFor(nodeId)
    runningApi.resolve()

    await ctx.environment.file.appendFile(`${ctx.environment.cwd}/index.js`, '\n')

    await ctx.executor.waitFor(nodeId)
    await ctx.environment.cancelDefer.resolve()

    const result = await resultPromise
    expect(result.success).toBeFalsy()
  })

  it('should restart watching task if once failed', async () => {
    const resultPromise = execute(workTree, ctx)

    const runningApi = await ctx.executor.waitFor(nodeId)
    runningApi.reject(new Error('runtime error'))

    await ctx.environment.file.appendFile(`${ctx.environment.cwd}/index.js`, '\n')

    await ctx.executor.waitFor(nodeId)
    await ctx.environment.cancelDefer.resolve()

    const result = await resultPromise
    expect(result.success).toBeFalsy()
  })
})
