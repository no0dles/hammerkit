import { getTestArg, loadExampleBuildFile } from './run-arg'

describe('store/restore', () => {
  const buildFile = loadExampleBuildFile('unknown')

  it('should validate unknown props', async () => {
    const [arg] = getTestArg()
    const task = await buildFile.getTask('example')
    const validations = Array.from(task.validate(arg))
    expect(validations).toEqual([])
  })

  it('should validate unknown props for docker tasks', async () => {
    const [arg] = getTestArg()
    const task = await buildFile.getTask('docker:example')
    const validations = Array.from(task.validate(arg))
    expect(validations).toEqual([])
  })
})
