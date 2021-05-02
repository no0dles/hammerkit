import { loadExampleBuildFile } from './run-arg'
import {validate} from '../src/rewrite/8-validate';

describe('unknown', () => {
  const buildFile = loadExampleBuildFile('unknown')

  function validateTask(name: string, expectedErrors: string[]) {
    const result = Array.from(validate(buildFile, name))
    expect(result.map(r => r.message)).toIncludeSameMembers(expectedErrors)
  }

  it('should validate unknown props', async () => {
    validateTask('example', ['cmd is an unknown configuration'])
  })

  it('should validate unknown props for local tasks with docker keys', async () => {
    validateTask('invalid:local:example', ['mounts is an unknown configuration'])
  })

  it('should validate unknown props for docker tasks', async () => {
    validateTask('docker:example', ['mount is an unknown configuration'])
  })
})
