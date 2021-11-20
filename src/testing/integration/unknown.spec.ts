import 'jest-extended'
import { getTestSuite } from '../get-test-suite'
import { validate } from '../../planner/validate'

describe('unknown', () => {
  const suite = getTestSuite('unknown', ['build.yaml'])

  afterAll(() => suite.close())

  async function validateTask(name: string, expectedErrors: string[]) {
    const { buildFile, environment } = await suite.setup()
    let i = 0
    for await (const message of validate(buildFile, environment, name)) {
      expect(expectedErrors[i++]).toEqual(message.message)
    }
    expect(i).toEqual(expectedErrors.length)
  }

  it('should validate unknown props', async () => {
    await validateTask('example', ['cmd is an unknown configuration'])
  })

  it('should validate unknown props for local tasks with docker keys', async () => {
    await validateTask('invalid:local:example', ['mounts is an unknown configuration'])
  })

  it('should validate unknown props for docker tasks', async () => {
    await validateTask('docker:example', ['mount is an unknown configuration'])
  })
})
