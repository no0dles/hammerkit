import 'jest-extended'
import { join } from 'path'
import { expectLog, getBuildFilePath, getTestArg, loadExampleBuildFile } from './run-arg'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { remove } from '../src/file/remove'
import { optimize } from '../src/optimizer/optimize'
import { writeWorkNodeCache } from '../src/optimizer/write-work-node-cache'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { WorkTree } from '../src/planner/work-tree'
import { ContainerWorkNode } from '../src/planner/work-node'

describe('cache', () => {
  const buildFile = loadExampleBuildFile('cache')
  const cachePath = join(buildFile.path, '.hammerkit')
  const sourceFile = join(buildFile.path, 'package.json')
  const buildFilePath = getBuildFilePath('cache')
  const sourceFileContent = readFileSync(sourceFile)
  const buildFileContent = readFileSync(buildFilePath)

  beforeEach(async () => {
    if (existsSync(cachePath)) {
      await remove(cachePath)
    }
  })

  afterEach(() => {
    writeFileSync(buildFilePath, buildFileContent)
    writeFileSync(sourceFile, sourceFileContent)
  })

  async function testCache(action: (workTree: WorkTree) => Promise<void>, expectInvalidate: boolean) {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    expect(workTree.nodes).toContainKey(`${buildFile.path}:example`)

    await writeWorkNodeCache(workTree.nodes[`${buildFile.path}:example`])
    await action(workTree)

    await optimize(workTree, arg)

    if (expectInvalidate) {
      expect(workTree.nodes[`${buildFile.path}:example`].status.state.type).toEqual('pending')
    } else {
      expect(workTree.nodes[`${buildFile.path}:example`].status.state.type).toEqual('completed')
    }
  }

  it('should run invalid cache on src file change', async () => {
    await testCache(async () => {
      appendFileSync(sourceFile, '\n')
    }, true)
  })

  it('should mount generations of dependant tasks', async () => {
    const [arg, mock] = getTestArg()
    const workTree = planWorkTree(buildFile, 'dependant')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()

    expectLog(mock, 'node_modules')
    expectLog(mock, 'package-lock.json')
    expectLog(mock, 'package.json')
  })

  it('should invalid cache on image change', async () => {
    await testCache(async (workTree) => {
      (workTree.nodes[`${buildFile.path}:example`] as ContainerWorkNode).image = '15.0.0'
    }, true)
  })
})
