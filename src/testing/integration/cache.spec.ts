import 'jest-extended'
import { BuildFile } from '../../parser/build-file'
import { writeWorkNodeCache } from '../../optimizer/write-work-node-cache'
import { WorkTree } from '../../planner/work-tree'
import { expectLog, expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { execute } from '../../executer/execute'
import { ExecutionContext } from '../../executer/execution-context'
import { optimize } from '../../optimizer/optimize'
import { ContainerWorkNode } from '../../planner/work-node'
import { getTestSuite } from '../get-test-suite'
import { join } from 'path'
import { getNode } from '../get-node'
import { getWorkNodeId } from '../../planner/work-node-id'

describe('cache', () => {
  const suite = getTestSuite('cache', ['build.yaml', 'package.json', 'package-lock.json'])

  afterAll(() => suite.close())

  async function testCache(
    action: (buildFile: BuildFile, workTree: WorkTree, context: ExecutionContext) => Promise<void>,
    expectInvalidate: boolean
  ) {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    expect(workTree.nodes).toContainKey(workTree.rootNode.id)

    await writeWorkNodeCache(workTree.nodes[workTree.rootNode.id], context)
    await action(buildFile, workTree, executionContext)

    await optimize(workTree, executionContext)

    if (expectInvalidate) {
      expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('pending')
    } else {
      expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('completed')
    }
  }

  it('should run invalid cache on src file change', async () => {
    await testCache(async (buildFile, workTree, context) => {
      await context.environment.file.appendFile(join(context.environment.cwd, 'package.json'), '\n')
    }, true)
  })

  it('should mount generations of dependant tasks', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'dependant')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `dependant`, 'node_modules')
  })

  it('should invalid cache on image change', async () => {
    await testCache(async (buildFile, workTree) => {
      const node = getNode(buildFile, workTree, 'example') as ContainerWorkNode
      node.image = '15.0.0'
      node.mergedTask.image = '15.0.0'
      delete workTree.nodes[node.id]
      node.id = getWorkNodeId(node.cwd, node.mergedTask, node.mergedDeps)
      workTree.nodes[node.id] = node
    }, true)
  })
})
