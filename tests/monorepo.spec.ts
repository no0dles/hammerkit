import { getTestArg, loadExampleBuildFile } from './run-arg'

describe('monorepo', () => {
  const buildFile = loadExampleBuildFile('monorepo')

  it('should build monorepo', async () => {
    const [arg] = getTestArg()
    const task = buildFile.getTask('build')
    arg.disableCache = true
    await task.execute(arg, [])
  })
})
