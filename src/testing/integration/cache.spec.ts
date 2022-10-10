import 'jest-extended'
import { BuildFile } from '../../parser/build-file'
import { writeWorkNodeCache } from '../../optimizer/write-work-node-cache'
import { WorkTree } from '../../planner/work-tree'
import { expectLog, expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { ContainerWorkNode } from '../../planner/work-node'
import { getTestSuite } from '../get-test-suite'
import { join } from 'path'
import { getNode } from '../get-node'
import { getWorkNodeId } from '../../planner/work-node-id'
import { Environment } from '../../executer/environment'
import { checkIfUpToDate } from '../../executer/scheduler/enqueue-next'

describe('cache', () => {
  const suite = getTestSuite('cache', ['build.yaml', 'package.json', 'package-lock.json'])

  afterAll(() => suite.close())

  async function testCache(
    action: (buildFile: BuildFile, workTree: WorkTree, environment: Environment) => Promise<void>,
    expectInvalidate: boolean
  ) {
    const { buildFile, environment } = await suite.setup()
    const workTree = planWorkTree(buildFile, { taskName: 'example', noContainer: false })

    const node = Object.values(workTree.nodes).find((n) => n.name === 'example')!
    expect(node).toBeDefined()

    await writeWorkNodeCache(node, environment)
    await action(buildFile, workTree, environment)

    const checksumUpToDate = await checkIfUpToDate({ ...node, caching: 'checksum' }, environment)
    const modifyDateUpToDate = await checkIfUpToDate({ ...node, caching: 'modify-date' }, environment)

    if (expectInvalidate) {
      expect(checksumUpToDate).toBeFalsy()
      expect(modifyDateUpToDate).toBeFalsy()
    } else {
      expect(checksumUpToDate).toBeTruthy()
      expect(modifyDateUpToDate).toBeTruthy()
    }
  }

  it('should run invalid cache on src file change', async () => {
    await testCache(async (buildFile, workTree, environment) => {
      await environment.file.appendFile(join(environment.cwd, 'package.json'), '\n')
    }, true)
  })

  it('should mount generations of dependant tasks', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'dependant' })
    await expectSuccessfulResult(result)
    await expectLog(result, `dependant`, 'node_modules')
  })

  it('should invalid cache on image change', async () => {
    await testCache(async (buildFile, workTree) => {
      const node = getNode(buildFile, workTree.nodes, 'example') as ContainerWorkNode
      node.plannedTask.image = '15.0.0'
      delete workTree.nodes[node.id]
      node.id = getWorkNodeId(node.plannedTask)
      workTree.nodes[node.id] = node
    }, true)
  })
})
