import { join } from 'path'
import { appendFileSync } from 'fs'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { writeWorkNodeCache } from '../src/optimizer/write-work-node-cache'
import { optimize } from '../src/optimizer/optimize'
import { getTestSuite } from './run-arg'

describe('glob', () => {
  const suite = getTestSuite('glob', ['build.yaml', 'test.md', 'test.txt'])

  afterAll(() => suite.close())

  it('should remove task after written cache', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const nodeId = `${buildFile.path}:example`
    expect(workTree.nodes).toContainKey(nodeId)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')

    await optimize(workTree, executionContext)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.nodes[`${buildFile.path}:example`], context)
    await optimize(workTree, executionContext)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('completed')
  })

  it('should keep being cached after ignored file changed', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const nodeId = `${buildFile.path}:example`
    expect(workTree.nodes).toContainKey(nodeId)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.nodes[`${buildFile.path}:example`], context)

    appendFileSync(join(buildFile.path, 'test.txt'), '\n')

    await optimize(workTree, executionContext)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('completed')
  })

  it('should invalid cache after file has changed', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const nodeId = `${buildFile.path}:example`
    expect(workTree.nodes).toContainKey(nodeId)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.nodes[`${buildFile.path}:example`], context)

    appendFileSync(join(buildFile.path, 'test.md'), '\n')

    await optimize(workTree, executionContext)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')
  })
})
