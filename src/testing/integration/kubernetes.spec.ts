import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'
import { requiresKubernetes } from '../requires-kubernetes'
import { testingTimeout } from '../testing-timeout'

describe('kubernetes', () => {
  const suite = getTestSuite('kubernetes', ['index.js', 'package.json', 'package-lock.json', '.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should', () => {
    expect(true).toBeTrue()
  })

  it(
    'should forward deployment',
    requiresKubernetes(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'api' })
      const result = await testingTimeout(cli.exec())
      await expectSuccessfulResult(result, environment)
    })
  )
})
