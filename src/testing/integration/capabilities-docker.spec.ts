import { join } from 'path'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { expectSuccessfulResult } from '../expect'
import { checkSysAdmin } from '../check-capability'

describe('capabilities (docker)', () => {
  it(
    'adds the capabilities a task names to its container, and none to the others',
    requiresLinuxContainers(async () => {
      await createTestCase('capabilities-docker', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            added: { image: 'alpine:3.21', capAdd: ['SYS_ADMIN'], cmds: [checkSysAdmin] },
            plain: { image: 'alpine:3.21', cmds: [`! ${checkSysAdmin}`] },
          },
        },
      }).setup(async (cwd, environment) => {
        for (const taskName of ['added', 'plain']) {
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName })
          await expectSuccessfulResult(await cli.runExec(), environment)
        }
      })
    }),
    120_000
  )
})
