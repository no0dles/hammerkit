import { join } from 'path'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { expectSuccessfulResult } from '../expect'

// A job container requests and is limited to its declared resources: its
// cgroup (v2) enforces 1.5 cpus as 150ms per 100ms period and 512Mi as a
// memory.max of 536870912 bytes, else the check exits non-zero and the job fails.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const namespace = `hammerkit-k8s-res-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')

describe('resources (kubernetes)', () => {
  it(
    'limits the cpus and memory of a job container',
    requiresKubernetes(async () => {
      await createTestCase('k8s-resources-task', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace } } },
          tasks: {
            limited: {
              image: 'alpine:3.21',
              src: ['input.txt'],
              resources: { cpus: '1500m', memory: '512Mi' },
              cmds: [`grep -qx '150000 100000' /sys/fs/cgroup/cpu.max && grep -qx 536870912 /sys/fs/cgroup/memory.max`],
            },
          },
        },
        'input.txt': `${Date.now()}\n`,
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'limited',
          environmentName: 'default',
        })
        await expectSuccessfulResult(await cli.runExec(), environment)
      })
    })
  )
})
