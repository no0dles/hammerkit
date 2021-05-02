import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import {executeTask} from '../src/rewrite/4-execute';

describe('docker', () => {
  const buildFile = loadExampleBuildFile('docker')

  it('should pull docker image', async () => {
    const [arg, mock] = getTestArg()
    const result = await executeTask(buildFile, 'example', true, arg)
    expect(result.success).toBeTruthy();
    expectLog(mock, '6.14.11')
    expectLog(mock, 'v14.16.0')
  })
})
