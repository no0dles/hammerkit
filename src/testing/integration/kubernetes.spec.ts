import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'
import { requiresKubernetesTest } from '../requires-kubernetes-test'

describe('kubernetes', () => {
  const suite = getTestSuite('kubernetes', ['index.js', 'package.json', 'package-lock.json', '.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should', () => {
    expect(true).toBeTrue()
  })

  it(
    'should forward deployment',
    requiresKubernetesTest(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'api' })
      const result = await cli.runExec()
      await expectSuccessfulResult(result, environment)
    })
  )
})
