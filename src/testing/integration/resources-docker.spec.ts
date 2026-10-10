import { join } from 'path'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { expectSuccessfulResult } from '../expect'

// The limits a container gets are the ones its cgroup enforces (cgroup v2):
// 1.5 cpus is a quota of 150ms per 100ms period, 512Mi a memory.max of
// 536870912 bytes. The checks exit non-zero, failing the run, without them.
const checkCpus = `grep -qx '150000 100000' /sys/fs/cgroup/cpu.max`
const checkMemory = `grep -qx 536870912 /sys/fs/cgroup/memory.max`

describe('resources (docker)', () => {
  it(
    'limits the cpus and memory of a task container',
    requiresLinuxContainers(async () => {
      await createTestCase('resources-docker-task', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            limited: {
              image: 'alpine:3.21',
              resources: { cpus: '1500m', memory: '512Mi' },
              cmds: [checkCpus, checkMemory],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'limited' })
        await expectSuccessfulResult(await cli.runExec(), environment)
      })
    }),
    120_000
  )

  it(
    'limits the cpus and memory of a service container',
    requiresLinuxContainers(async () => {
      await createTestCase('resources-docker-service', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            limited: {
              image: 'alpine:3.21',
              shell: 'sh',
              cmd: 'sleep 3600',
              resources: { cpus: 1.5, memory: '512Mi' },
              // the service only turns healthy inside its limits
              healthcheck: { cmd: `${checkCpus} && ${checkMemory}`, timeout: '30s' },
            },
          },
          tasks: {
            use: { image: 'alpine:3.21', needs: ['limited'], cmds: ['true'] },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'use' })
        await expectSuccessfulResult(await cli.runExec(), environment)
      })
    }),
    120_000
  )
})
