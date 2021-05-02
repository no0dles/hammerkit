import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import {executeTask} from '../src/rewrite/4-execute';
import {nodes} from '../src/rewrite/1-plan';

describe('reference', () => {
  const buildFile = loadExampleBuildFile('reference')

  it('should run included task', async () => {
    const [arg, mock] = getTestArg()
    await executeTask(buildFile, 'example', true, arg)
    expectLog(mock, 'foobar')
    expectLog(mock, 'cat foobar.txt')
    expectLog(mock, 'hammertime')
    expectLog(mock, 'echo hammertime')
  })

  it('should list task with references tasks nested', async () => {
    const node = nodes(buildFile)
    expect(Object.keys(node).map(t => node[t].name)).toEqual(['example', 'foo:bar', 'foo:sub:sub'])
  })
})
