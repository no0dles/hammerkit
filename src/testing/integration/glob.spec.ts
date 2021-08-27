import { join } from 'path'
import { appendFileSync } from 'fs'
import { writeWorkNodeCache } from '../../optimizer/write-work-node-cache'
import { optimize } from '../../optimizer/optimize'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'

describe('glob', () => {
  const suite = getTestSuite('glob', ['build.yaml', 'test.md', 'test.txt'])

  afterAll(() => suite.close())

  it('should remove task after written cache', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('pending')

    await optimize(workTree, executionContext)
    expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.rootNode, context)
    await optimize(workTree, executionContext)
    expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('completed')
  })

  it('should keep being cached after ignored file changed', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.rootNode, context)

    appendFileSync(join(buildFile.path, 'test.txt'), '\n')

    await optimize(workTree, executionContext)
    expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('completed')
  })

  it('should invalid cache after file has changed', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.rootNode, context)

    appendFileSync(join(buildFile.path, 'test.md'), '\n')

    await optimize(workTree, executionContext)
    expect(workTree.nodes[workTree.rootNode.id].status.state.type).toEqual('pending')
  })
})
