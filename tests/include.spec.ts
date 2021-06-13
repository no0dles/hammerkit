import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import { executeTask } from '../src/rewrite/4-execute'
import { plan } from '../src/rewrite/1-plan'

describe('include', () => {
  const buildFile = loadExampleBuildFile('include')

  it('should run included task', async () => {
    const [arg, mock] = getTestArg()
    await executeTask(buildFile, 'example', true, 'checksum', arg)
    expectLog(mock, 'foobar')
    expectLog(mock, 'cat foobar.txt')
  })

  it('should get name:example', async () => {
    const [arg] = getTestArg()
    const result = await executeTask(buildFile, 'name:example', true, 'checksum', arg)
    expect(result.success).toBeTruthy()
  })

  it('should get included task', async () => {
    const tree = plan(buildFile, 'foo:bar')
    expect(tree.rootNode.name).toEqual('foo:bar')
    expect(tree.rootNode.path).toEqual(buildFile.path)
  })
})
