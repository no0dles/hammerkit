import { getTestSuite } from '../get-test-suite'
import { emptyWorkLabelScope } from '../../executer/work-scope'

describe('invalid', () => {
  const suite = getTestSuite('invalid', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should throw on invalid yaml', async () => {
    try {
      await suite.setup(emptyWorkLabelScope('all'))
      expect.fail('should not be called')
    } catch (e: any) {
      expect(e.message).toStartWith('unable to parse')
    }
  })
})
