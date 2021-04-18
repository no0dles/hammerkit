import { getTestArg, loadExampleBuildFile } from './run-arg'

describe('clean', () => {
  const buildFile = loadExampleBuildFile('cmd')

  it('should run with path arg', async () => {
    const [arg, mock] = getTestArg()
    await buildFile.getTask('example').execute(arg, [])
    expect(mock.mock.calls.some((c) => c[0].endsWith('cmd/sub'))).toBeTruthy()
  })
})
