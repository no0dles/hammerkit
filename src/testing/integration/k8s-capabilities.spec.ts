import { join } from 'path'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { expectSuccessfulResult } from '../expect'
import { checkSysAdmin } from '../check-capability'

// On the build file's own cluster the capabilities go into the container's securityContext;
// a server adds its sandbox's RuntimeClass on top (job-placement.spec.ts)

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const namespace = `hammerkit-k8s-cap-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')

describe('capabilities (kubernetes)', () => {
  it(
    'adds the capabilities a task names to its job container, and none to the others',
    requiresKubernetes(async () => {
      await createTestCase('k8s-capabilities', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace } } },
          tasks: {
            added: { image: 'alpine:3.21', src: ['input.txt'], capAdd: ['SYS_ADMIN'], cmds: [checkSysAdmin] },
            plain: { image: 'alpine:3.21', src: ['input.txt'], cmds: [`! ${checkSysAdmin}`] },
          },
        },
        'input.txt': `${Date.now()}\n`,
      }).setup(async (cwd, environment) => {
        for (const taskName of ['added', 'plain']) {
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
            taskName,
            environmentName: 'default',
          })
          await expectSuccessfulResult(await cli.runExec(), environment)
        }
      })
    })
  )
})
