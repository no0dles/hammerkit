import { join } from 'path'
import { writeFileSync } from 'fs'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { expectSuccessfulResult } from '../expect'

// What a dependency generates reaches a task on a cluster as it does on docker: a file (the
// digest of an image a `build` pushed) from the claim of the dependency, and a folder the task
// also lists in its src (a context a dependency writes) as the dependency's output, not as an
// empty source.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const namespace = `hammerkit-k8s-files-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')

describe('file outputs (kubernetes)', () => {
  it(
    'hands a file and a folder of a dependency on to a container task',
    requiresKubernetes(async () => {
      await createTestCase('k8s-file-outputs', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        'input.txt': `${Date.now()}\n`,
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace } } },
          tasks: {
            make: {
              image: 'alpine:3.21',
              src: ['input.txt'],
              generates: ['out/ref.txt', 'ctx'],
              cmds: [
                'mkdir -p out ctx',
                'echo registry/app@sha256:abc > out/ref.txt',
                'echo FROM scratch > ctx/Dockerfile',
              ],
            },
            read: {
              image: 'alpine:3.21',
              deps: ['make'],
              src: ['input.txt', 'ctx'],
              cache: 'none',
              cmds: ['test "$(cat out/ref.txt)" = registry/app@sha256:abc', 'grep -q "FROM scratch" ctx/Dockerfile'],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'read',
          environmentName: 'default',
        })
        await expectSuccessfulResult(await cli.runExec(), environment)
        await cli.clean()
      })
    }),
    300_000
  )

  // a deploy that lists the digest of its image in src: the file is mounted from the claim of
  // the dependency alone (twice, the Job was refused), and the task is skipped while it is
  it(
    'mounts a file of a dependency the task lists in its src, and keeps the task cached while the dependency is',
    requiresKubernetes(async () => {
      await createTestCase('k8s-file-output-in-src', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        'input.txt': `${Date.now()}\n`,
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace: `${namespace}-src` } } },
          tasks: {
            make: {
              image: 'alpine:3.21',
              src: ['input.txt'],
              generates: ['out/ref.txt'],
              cmds: ['mkdir -p out', 'cat input.txt > out/ref.txt'],
            },
            deploy: {
              image: 'alpine:3.21',
              deps: ['make'],
              src: ['out/ref.txt'],
              cmds: ['test "$(cat out/ref.txt)" = "$(cat input.txt)"'],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        const run = async () => {
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
            taskName: 'deploy',
            environmentName: 'default',
          })
          const result = await cli.runExec()
          await expectSuccessfulResult(result, environment)
          return { cli, deploy: result.state.tasks['deploy'].state.current }
        }
        expect((await run()).deploy).toMatchObject({ type: 'completed', cached: false })
        const again = await run()
        expect(again.deploy).toMatchObject({ type: 'completed', cached: true })
        writeFileSync(join(cwd, 'input.txt'), `${Date.now()} changed\n`)
        const changed = await run()
        expect(changed.deploy).toMatchObject({ type: 'completed', cached: false })
        await changed.cli.clean()
      })
    }),
    300_000
  )
})
