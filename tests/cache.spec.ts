import 'jest-extended'
import { optimize } from '../src/optimizer/optimize'
import { writeWorkNodeCache } from '../src/optimizer/write-work-node-cache'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { WorkTree } from '../src/planner/work-tree'
import { ContainerWorkNode } from '../src/planner/work-node'
import { expectLog, expectSuccessfulResult, getTestSuite } from './run-arg'
import { ExecutionContext } from '../src/run-arg'
import { join } from 'path'
import { BuildFile } from '../src/parser/build-file'

describe('cache', () => {
  const suite = getTestSuite('cache', ['build.yaml', 'package.json', 'package-lock.json'])

  afterAll(() => suite.close())

  async function testCache(
    action: (buildFile: BuildFile, workTree: WorkTree, context: ExecutionContext) => Promise<void>,
    expectInvalidate: boolean
  ) {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    expect(workTree.nodes).toContainKey(`${buildFile.path}:example`)

    await writeWorkNodeCache(workTree.nodes[`${buildFile.path}:example`], context)
    await action(buildFile, workTree, executionContext)

    await optimize(workTree, executionContext)

    if (expectInvalidate) {
      expect(workTree.nodes[`${buildFile.path}:example`].status.state.type).toEqual('pending')
    } else {
      expect(workTree.nodes[`${buildFile.path}:example`].status.state.type).toEqual('completed')
    }
  }

  it('should run invalid cache on src file change', async () => {
    await testCache(async (buildFile, workTree, context) => {
      await context.context.file.appendFile(join(context.context.cwd, 'package.json'), '\n')
    }, true)
  })

  it('should mount generations of dependant tasks', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'dependant')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:dependant`, 'node_modules')
  })

  it('should invalid cache on image change', async () => {
    await testCache(async (buildFile, workTree) => {
      (workTree.nodes[`${buildFile.path}:example`] as ContainerWorkNode).image = '15.0.0'
    }, true)
  })
})
