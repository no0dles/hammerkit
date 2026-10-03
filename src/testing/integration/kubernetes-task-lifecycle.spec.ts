import { join } from 'path'
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
        expect(result.state.tasks['job'].state.current.type).toBe('error')
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
})
