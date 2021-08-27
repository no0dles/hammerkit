import { getTestSuite } from '../get-test-suite'

describe('invalid', () => {
  const suite = getTestSuite('invalid', ['build.yaml'])

  afterAll(() => suite.close())

  it('should throw on invalid yaml', async () => {
    try {
      await suite.setup()
      expect.fail('should not be called')
    } catch (e) {
      expect(e.message).toStartWith('unable to parse')
    }
  })
})
