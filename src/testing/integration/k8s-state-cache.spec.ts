import { createTestCase } from '../test-case'
import { requiresKubernetes } from '../requires-kubernetes'

/**
 * Regression test for the k8s currentStateKey caching wired up in
 * feature/shared-services. Running `up` twice with no input change should
 * produce a cached second run, not redeploy.
 */
describe('k8s deployment caches via hammerkit.dev/state label', () => {
  const namespace = `hammerkit-cache-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`

  const suite = createTestCase('k8s-state-cache', {
    '.hammerkit.yaml': {
      services: {
        redis: {
          image: 'redis:7-alpine',
          ports: [':6379'],
        },
      },
      environments: {
        default: {
          kubernetes: {
            namespace,
            context: process.env.CLUSTER_NAME || 'docker-desktop',
          },
        },
      },
    },
  })

  it(
    'second up() is a cache hit on the same state key',
    requiresKubernetes(async () => {
      await suite.cli({}, async (cli, env) => {
        await cli.runUp({ daemon: true })
        const firstKey = await cli.service('redis').runtime.currentStateKey(env)
        expect(firstKey).not.toBeNull()

        await cli.runUp({ daemon: true })
        const secondKey = await cli.service('redis').runtime.currentStateKey(env)
        expect(secondKey).toBe(firstKey)
      })
    }),
    240000
  )
})
