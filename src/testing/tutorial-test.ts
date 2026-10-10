import { join } from 'path'
import { getTestSuite } from './get-test-suite'
import { expectSuccessfulResult } from './expect'
import { requiresLinuxContainers } from './requires-linux-containers'
import { summarizeRun } from '../executer/run-summary'

// The language tutorials on hammerkit.dev embed their example's files, so each
// tutorial is exactly as good as this run: `ci` builds from scratch, exports its
// artifact (if it builds one) into the project, and a second run comes entirely
// from the cache.
export function describeTutorial(example: string, files: string[], artifact?: string): void {
  describe(example, () => {
    const suite = getTestSuite(example, files)

    afterAll(() => suite.close())

    it(
      'runs ci, then again entirely from the cache',
      requiresLinuxContainers(async () => {
        const { cli, environment } = await suite.setup({ taskName: 'ci' })

        const first = await cli.runExec()
        await expectSuccessfulResult(first, environment)
        expect(summarizeRun(first.state, 0).cached).toBe(0)
        if (artifact) {
          expect(await environment.file.exists(join(environment.cwd, artifact))).toBe(true)
        }

        const second = await cli.runExec()
        await expectSuccessfulResult(second, environment)
        expect(summarizeRun(second.state, 0)).toMatchObject({ executed: 0, failed: 0, cancelled: 0 })
      })
    )
  })
}
