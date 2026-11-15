import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { ContainerWorkService } from './work-service'

describe('restarts of a service', () => {
  it('takes how often a service may be restarted from its build file, null when it says none', async () => {
    await createTestCase('service-restarts', {
      '.hammerkit.yaml': {
        services: {
          patient: { image: 'node:22-alpine', restarts: 5 },
          plain: { image: 'node:22-alpine' },
        },
      },
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      expect((cli.service('patient').data as ContainerWorkService).restarts).toBe(5)
      expect((cli.service('plain').data as ContainerWorkService).restarts).toBeNull()
    })
  })
})
