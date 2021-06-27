import { getTestArg, loadExampleBuildFile } from './run-arg'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { remove } from '../src/file/remove'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { writeWorkNodeCache } from '../src/optimizer/write-work-node-cache'
import { optimize } from '../src/optimizer/optimize'

describe('glob', () => {
  const buildFile = loadExampleBuildFile('glob')
  const cachePath = join(buildFile.path, '.hammerkit')

  beforeEach(async () => {
    await remove(cachePath)
  })

  it('should remove task after written cache', async () => {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    const nodeId = `${buildFile.path}:example`
    expect(workTree.nodes).toContainKey(nodeId)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')

    await optimize(workTree, arg)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.nodes[`${buildFile.path}:example`])
    await optimize(workTree, arg)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('completed')
  })

  it('should keep being cached after ignored file changed', async () => {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    const nodeId = `${buildFile.path}:example`
    expect(workTree.nodes).toContainKey(nodeId)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.nodes[`${buildFile.path}:example`])

    appendFileSync(join(buildFile.path, 'test.txt'), '\n')

    await optimize(workTree, arg)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('completed')
  })

  it('should invalid cache after file has changed', async () => {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    const nodeId = `${buildFile.path}:example`
    expect(workTree.nodes).toContainKey(nodeId)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')

    await writeWorkNodeCache(workTree.nodes[`${buildFile.path}:example`])

    appendFileSync(join(buildFile.path, 'test.md'), '\n')

    await optimize(workTree, arg)
    expect(workTree.nodes[nodeId].status.state.type).toEqual('pending')
  })
})
