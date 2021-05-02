import { getTestArg, loadExampleBuildFile } from './run-arg'
import {executeTask} from '../src/rewrite/4-execute';

describe('monorepo', () => {
  const buildFile = loadExampleBuildFile('monorepo')

  it('should build monorepo', async () => {
    const [arg] = getTestArg()
    await executeTask(buildFile, 'build', true, arg)
  })
})
