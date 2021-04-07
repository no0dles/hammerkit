import { join, dirname } from 'path'
import { getTestArg, loadExampleBuildFile } from './run-arg'
import { appendFileSync, existsSync } from 'fs'
import { remove } from '../src/remove'

describe('cache', () => {
  const buildFile = loadExampleBuildFile('cache')
  const cachePath = join(dirname(buildFile.fileName), '.hammerkit')
  const sourceFile = join(dirname(buildFile.fileName), 'package.json')

  beforeEach(async () => {
    if (existsSync(cachePath)) {
      await remove(cachePath)
    }
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

    const lsResult = mock.mock.calls.find((c) => c[0] === 'ls')
    const resultIndex = mock.mock.calls.indexOf(lsResult) + 1
    expect(mock.mock.calls[resultIndex][0]).toEqual('node_modules')
  })
})
