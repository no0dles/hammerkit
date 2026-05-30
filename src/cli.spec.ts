import { join } from 'path'
import { createTestCase } from './testing/test-case'
import { createCli } from './program'

// Drives the real parse pipeline (createCli) over an in-memory build file and
// then exercises Cli lookups against the resulting work tree — a real "not
// found" situation, no mocking.
describe('Cli', () => {
  it('service() throws for an unknown service name', async () => {
    const testCase = createTestCase('cli-service', {
      '.hammerkit.yaml': {
        services: { api: { image: 'nginx', ports: [] } },
        tasks: { build: { cmds: ['tsc'], needs: ['api'] } },
      },
    })
    await testCase.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      expect(() => cli.service('missing')).toThrow('unable to find service missing')
    })
  })
})
