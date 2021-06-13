import { getTestArg, loadExampleBuildFile } from './run-arg'
import { executeTask } from '../src/rewrite/4-execute'

describe('clean', () => {
  const buildFile = loadExampleBuildFile('cmd')

  it('should run with path arg', async () => {
    const [arg, mock] = getTestArg()
    await executeTask(buildFile, 'example', true, 'checksum', arg)
    expect(mock.mock.calls.some((c) => c[0].endsWith('cmd/sub'))).toBeTruthy()
  })
})
