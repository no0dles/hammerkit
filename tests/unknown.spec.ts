import { getTestArg, loadExampleBuildFile } from './run-arg'

describe('unknown', () => {
  const buildFile = loadExampleBuildFile('unknown')

  it('should validate unknown props', async () => {
    const [arg] = getTestArg()
    const task = await buildFile.getTask('example')
    const validations = Array.from(task.validate(arg))
    expect(validations.map(v => v.message)).toEqual(['cmd is an unknown configuration'])
  })

  it('should validate unknown props for local tasks with docker keys', async () => {
    const [arg] = getTestArg()
    const task = await buildFile.getTask('invalid:local:example')
    const validations = Array.from(task.validate(arg))
    expect(validations.map(v => v.message)).toEqual(['mounts is an unknown configuration'])
  })

  it('should validate unknown props for docker tasks', async () => {
    const [arg] = getTestArg()
    const task = await buildFile.getTask('docker:example')
    const validations = Array.from(task.validate(arg))
    expect(validations.map(v => v.message)).toEqual(['mount is an unknown configuration'])
  })
})
