import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'
import { planWorkTree } from '../../planner/utils/plan-work-tree'

describe('services', () => {
  const suite = getTestSuite('services', ['src/index.ts', 'package.json', 'tsconfig.json', 'build.yaml'])

  afterAll(() => suite.close())

  it('should run service', async () => {
    const { buildFile, executionContext, context } = await suite.setup()
    executionContext.events.on((evt) => {
      console.log(evt.type, evt.oldState, evt.newState)
    })
    context.console.on((type, message) => {
      console.log(type, message)
    })

    const workTree = planWorkTree(buildFile, 'api')
    const result = await execute(workTree, executionContext)
    expect(result.success).toBeTruthy()
  }, 120000)
})
