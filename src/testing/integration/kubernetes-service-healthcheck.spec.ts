import { join } from 'path'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { expectSuccessfulResult } from '../expect'

// Services checked by a request or a connection to one of their ports on a cluster: the
// kubelet's own httpGet and tcpSocket probes, and the busybox the pod gets for status codes
// httpGet can't check. The image has neither curl nor wget.
const context = process.env.CLUSTER_NAME || 'docker-desktop'
const namespace = `hammerkit-k8s-hc-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')

const httpServer = { image: 'python:3.13-slim', ports: [8000], cmd: 'python -m http.server 8000' }
// A workdir of its own gives each service an id of its own: services that differ only in
// their command share one, and with it the labels their NetworkPolicy selects.

const buildFile = {
  environments: { default: { kubernetes: { context, namespace, networkPolicy: 'enforced' } } },
  services: {
    // its NetworkPolicy lets in only what needs it, not the kubelet's requests
    web: { ...httpServer, workdir: '/web', network: 'none', healthcheck: { http: { port: 8000 }, timeout: '2m' } },
    missing: {
      ...httpServer,
      workdir: '/missing',
      healthcheck: { http: { port: 8000, path: '/missing', status: [404] }, timeout: '2m' },
    },
    echo: {
      image: 'python:3.13-slim',
      ports: [7000],
      workdir: '/echo',
      cmd: 'python -c "import socketserver as s; s.TCPServer((str(), 7000), s.BaseRequestHandler).serve_forever()"',
      healthcheck: { tcp: { port: 7000 }, timeout: '2m' },
    },
    // answers 200, never the 204 it expects
    wrong: { ...httpServer, workdir: '/wrong', healthcheck: { http: { port: 8000, status: [204] }, timeout: '20s' } },
  },
  tasks: {
    use: {
      image: 'alpine:3.21',
      src: ['input.txt'],
      network: 'none',
      needs: ['web', 'missing', 'echo'],
      cmds: ['wget -q -T 5 -O /dev/null http://web:8000/ && nc -z -w 5 echo 7000'],
    },
  },
}

describe('kubernetes service healthcheck', () => {
  it(
    'waits for http and tcp healthchecks of services without curl',
    requiresKubernetes(async () => {
      await createTestCase('k8s-service-healthcheck', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': buildFile,
        'input.txt': `${Date.now()}\n`,
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'use',
          environmentName: 'default',
        })
        await expectSuccessfulResult(await cli.runExec(), environment)
      })
    }),
    300_000
  )

  it(
    'fails a service whose http check never gets one of its status codes once its timeout is up',
    requiresKubernetes(async () => {
      const suite = createTestCase('k8s-service-healthcheck-wrong', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': buildFile,
      })
      await suite.cli({ serviceNames: ['wrong'], environmentName: 'default' }, async (cli) => {
        const result = await cli.runUp({ daemon: true })
        try {
          expect(result.success).toBe(false)
          const state = cli.service('wrong').state.current
          expect(state.type === 'error' ? state.errorMessage : state.type).toContain(
            'service wrong did not pass its healthcheck "GET http://:8000/ (204)" within 20s'
          )
        } finally {
          await cli.runDown()
        }
      })
    }),
    240_000
  )
})
