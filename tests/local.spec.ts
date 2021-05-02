import { getTestArg, loadExampleBuildFile } from './run-arg'
import {executeTask} from '../src/rewrite/4-execute';

describe('local', () => {
  const buildFile = loadExampleBuildFile('local')

  it('should run local task', async () => {
    const [arg] = getTestArg()
    await executeTask(buildFile, 'example', true, arg)
  })
})
