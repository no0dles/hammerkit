import { join } from 'path'
import { KubeConfig, CoreV1Api } from '@kubernetes/client-node'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'

// On Kubernetes a task's secrets live in a Secret its job references, removed
// once the task has run.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const namespace = `hammerkit-k8s-secrets-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
const TOKEN = 'k8s-token-91c2'

async function secretNames(): Promise<string[]> {
  const config = new KubeConfig()
  config.loadFromDefault()
  config.setCurrentContext(context)
  const secrets = await config.makeApiClient(CoreV1Api).listNamespacedSecret({
    namespace,
    labelSelector: 'hammerkit.dev/id',
  })
  return secrets.items.filter((s) => !s.metadata?.deletionTimestamp).map((s) => s.metadata?.name ?? '')
}

describe('kubernetes secrets', () => {
  it(
    'hands env and file secrets to a job and removes the secret afterwards',
    requiresKubernetes(async () => {
      await createTestCase('k8s-secrets', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace } } },
          tasks: {
            job: {
              image: 'alpine:3.19',
              src: ['input.txt'],
              secrets: [
                { from: 'env:HK_SECRET_TOKEN', env: 'TOKEN' },
                { from: 'env:HK_SECRET_TOKEN', path: '/run/secrets/token' },
              ],
              cmds: ['test "$TOKEN" = "' + TOKEN + '" && test "$(cat /run/secrets/token)" = "' + TOKEN + '"'],
            },
          },
        },
        'input.txt': `${Date.now()}\n`,
      }).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, HK_SECRET_TOKEN: TOKEN }
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'job',
          environmentName: 'default',
        })
        const result = await cli.runExec()
        expect(result.state.tasks['job'].state.current.type).toBe('completed')
        expect(await secretNames()).toEqual([])
      })
    })
  )
})
