import 'jest-extended'
import { getTestSuite } from '../get-test-suite'

describe('unknown', () => {
  const suite = getTestSuite('unknown', ['build.yaml'])

  afterAll(() => suite.close())

  async function validateTask(name: string, expectedErrors: string[]) {
    const { cli } = await suite.setup({ taskName: name })
    let i = 0
    for await (const message of cli.validate()) {
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
