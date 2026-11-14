import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { x } from 'tar'
import { KubeConfig, BatchV1Api, CoreV1Api } from '@kubernetes/client-node'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'

// A task running as a Kubernetes job must end like it does on docker: a job that
// fails fails the task (instead of waiting forever for success), and a task that
// hits its timeout is aborted and its job deleted.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const namespace = `hammerkit-k8s-life-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')

function project(task: { [key: string]: unknown }) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      environments: { default: { kubernetes: { context, namespace } } },
      tasks: { job: { image: 'alpine:3.19', src: ['input.txt'], ...task } },
    },
    'input.txt': `${Date.now()}\n`,
  }
}

async function jobNames(): Promise<string[]> {
  const config = new KubeConfig()
  config.loadFromDefault()
  config.setCurrentContext(context)
  const jobs = await config.makeApiClient(BatchV1Api).listNamespacedJob({ namespace })
  return jobs.items.filter((job) => !job.metadata?.deletionTimestamp).map((job) => job.metadata?.name ?? '')
}

describe('kubernetes task lifecycle', () => {
  it(
    'fails a task whose job fails instead of waiting for it forever',
    requiresKubernetes(async () => {
      await createTestCase('k8s-job-fails', project({ cmds: ['sh -c "exit 3"'] })).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'job',
          environmentName: 'default',
        })
        const result = await cli.runExec()
        expect(result.success).toBe(false)
        // with the exit code of its command, as on docker
        expect(result.state.tasks['job'].state.current).toMatchObject({ type: 'crash', exitCode: 3 })
      })
    })
  )

  it(
    'aborts a job at the task timeout and deletes it',
    requiresKubernetes(async () => {
      await createTestCase('k8s-job-timeout', project({ timeout: '10s', cmds: ['sleep 300'] })).setup(
        async (cwd, environment) => {
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
            taskName: 'job',
            environmentName: 'default',
          })
          const started = Date.now()
          const result = await cli.runExec()
          expect(Date.now() - started).toBeLessThan(90_000)
          expect(result.state.tasks['job'].state.current).toMatchObject({
            type: 'error',
            errorMessage: 'timed out after 10s',
          })
          expect(await jobNames()).toEqual([])
        }
      )
    })
  )

  // outputs live in the task's claim: once it is gone, the finished job alone is
  // not a reusable result
  it(
    'has no reusable state once the claim holding its outputs is deleted',
    requiresKubernetes(async () => {
      await createTestCase(
        'k8s-job-claim-deleted',
        project({ generates: ['dist'], cmds: ['mkdir -p dist', 'cp input.txt dist/out.txt'] })
      ).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'job',
          environmentName: 'default',
        })
        expect((await cli.runExec()).success).toBe(true)
        const task = cli.task('job')
        expect(await task.runtime.currentStateKey(environment)).not.toBeNull()

        const config = new KubeConfig()
        config.loadFromDefault()
        config.setCurrentContext(context)
        await config
          .makeApiClient(CoreV1Api)
          .deleteNamespacedPersistentVolumeClaim({ name: `hammerkit-${task.id()}`, namespace })
        expect(await task.runtime.currentStateKey(environment)).toBeNull()
      })
    })
  )

  // run_Kv-5lFVjvxEtgEjQ: Kubernetes made a directory of `lcov.info`, an output that is a file,
  // and the task failed with EISDIR. It is a file in the pod, archived by its name as on
  // docker, and restored as a file
  it(
    'writes an output that is a file, and stores and restores it as one',
    requiresKubernetes(async () => {
      await createTestCase('k8s-job-output-file', {
        // and ones inside a folder of a src, which the pod mounts read only (lcov.info of a
        // package's coverage folder, and its dist folder)
        ...project({
          src: ['input.txt', 'pkg'],
          generates: ['report.txt', 'out', 'pkg/coverage/lcov.info', 'pkg/dist'],
          cmds: [
            'test -f report.txt',
            'test -f pkg/coverage/lcov.info',
            // in place: busybox's cp removes and recreates a file, which a mounted one refuses
            'cat input.txt > report.txt',
            'cat input.txt > pkg/coverage/lcov.info',
            'mkdir -p out',
            'echo dir > out/a.txt',
            'echo dist > pkg/dist/a.txt',
          ],
        }),
        'pkg/index.txt': 'pkg\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'job',
          environmentName: 'default',
        })
        const result = await cli.runExec()
        expect(result.success, JSON.stringify(result.state.tasks['job'].state.current)).toBe(true)

        const input = readFileSync(join(cwd, 'input.txt'), 'utf8')
        const unpack = async (archives: string) => {
          const dir = mkdtempSync(join(tmpdir(), 'hammerkit-output-file-'))
          for (const output of ['report.txt', 'pkg-coverage-lcov.info', 'pkg-dist']) {
            const archive = readdirSync(archives).find((name) => name.startsWith(output))
            expect(archive, readdirSync(archives).join(', ')).toBeDefined()
            await x({ file: join(archives, archive ?? ''), cwd: dir })
          }
          return dir
        }
        const first = join(cwd, 'cache-1')
        await cli.store(first)
        const stored = await unpack(first)
        try {
          expect(readdirSync(stored).sort()).toEqual(['a.txt', 'lcov.info', 'report.txt'])
          expect(readFileSync(join(stored, 'a.txt'), 'utf8')).toEqual('dist\n')
          expect(readFileSync(join(stored, 'report.txt'), 'utf8')).toEqual(input)
          expect(readFileSync(join(stored, 'lcov.info'), 'utf8')).toEqual(input)
        } finally {
          rmSync(stored, { recursive: true, force: true })
        }

        // into a new claim, as a file again: a store of it reads what the restore wrote
        await cli.clean()
        await cli.restore(first)
        const second = join(cwd, 'cache-2')
        await cli.store(second)
        const restored = await unpack(second)
        try {
          expect(readFileSync(join(restored, 'report.txt'), 'utf8')).toEqual(input)
          expect(readFileSync(join(restored, 'lcov.info'), 'utf8')).toEqual(input)
          expect(readFileSync(join(restored, 'a.txt'), 'utf8')).toEqual('dist\n')
        } finally {
          rmSync(restored, { recursive: true, force: true })
        }
      })
    })
  )
})
