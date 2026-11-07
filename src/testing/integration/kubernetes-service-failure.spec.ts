import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'

// A service on a cluster that can't become ready says why, from the cluster, at once and
// not when a deadline passes; and what it printed is in its log, as on Docker.
describe('kubernetes service failures', () => {
  const namespace = `hammerkit-k8s-fail-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  const suite = createTestCase('kubernetes-service-failure', {
    '.hammerkit.yaml': {
      services: {
        // without a healthcheck: ready while it runs, which it does for a moment each time
        crashing: {
          image: 'alpine:3.19',
          cmd: 'sh -c "echo crash-output-of-the-service && exit 4"',
          ports: [':8080'],
        },
        // with one it never passes: it crashes before the healthcheck's time is up
        'crashing-checked': {
          image: 'alpine:3.19',
          cmd: 'sh -c "echo crash-output-of-the-service && sleep 1 && exit 4"',
          ports: [':8080'],
          healthcheck: { cmd: 'test -f /never', timeout: '5m' },
        },
        unpulled: {
          image: 'hammerkit-does-not-exist.invalid/none:1',
          ports: [':8080'],
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

  for (const [name, title] of [
    ['crashing', 'without a healthcheck'],
    ['crashing-checked', 'with a healthcheck'],
  ]) {
    it(
      `fails a service ${title} that keeps crashing with how it exited, and keeps what it printed`,
      requiresKubernetes(async () => {
        await suite.cli({ serviceNames: [name] }, async (cli) => {
          const started = Date.now()
          const result = await cli.runUp({ daemon: true })
          try {
            expect(result.success).toBe(false)
            const state = cli.service(name).state.current
            expect(state.type).toBe('error')
            expect(state.type === 'error' ? state.errorMessage : '').toContain(
              `service ${name} can not become ready, it keeps crashing: it exited with code 4`
            )
            const logs = Array.from(cli.service(name).status.logs()).map((log) => log.message)
            expect(logs).toContain('crash-output-of-the-service')
            // before, only the healthcheck's time ended the wait, and without one it passed
            expect(Date.now() - started).toBeLessThan(150_000)
          } finally {
            await cli.runDown()
          }
        })
      }),
      240_000
    )
  }

  it(
    'fails a service whose image can not be pulled with the reason of the cluster',
    requiresKubernetes(async () => {
      await suite.cli({ serviceNames: ['unpulled'] }, async (cli) => {
        const result = await cli.runUp({ daemon: true })
        try {
          expect(result.success).toBe(false)
          const state = cli.service('unpulled').state.current
          expect(state.type === 'error' ? state.errorMessage : state.type).toContain(
            'service unpulled can not become ready, its image hammerkit-does-not-exist.invalid/none:1 could not be pulled'
          )
        } finally {
          await cli.runDown()
        }
      })
    }),
    180_000
  )
})
