import { join, dirname } from 'path'
import { expectLog, getBuildFilePath, getTestArg, loadExampleBuildFile } from './run-arg'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { remove } from '../src/remove'

describe('cache', () => {
  const buildFile = loadExampleBuildFile('cache')
  const cachePath = join(dirname(buildFile.fileName), '.hammerkit')
  const sourceFile = join(dirname(buildFile.fileName), 'package.json')
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

  it('should run task only if not cached', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg] = getTestArg()
    expect(await exampleTask.isCached(arg)).toBeFalsy()
    await exampleTask.execute(arg)
    expect(await exampleTask.isCached(arg)).toBeTruthy()
    await exampleTask.execute(arg)
    appendFileSync(sourceFile, '\n')
    expect(await exampleTask.isCached(arg)).toBeFalsy()
  })

  it('should mount generations of dependant tasks', async () => {
    const exampleTask = buildFile.getTask('dependant')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)

    expectLog(mock, 'ls')
    expectLog(mock, 'node_modules')
  })
})
