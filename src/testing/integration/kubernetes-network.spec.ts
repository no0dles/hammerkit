import { join } from 'path'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { expectSuccessfulResult } from '../expect'

// A limited job gets a NetworkPolicy: egress to the pods of the services it
// needs and, under `allow`, to its egress proxy. Nothing else answers, so
// the request to an outside address times out. kind's kindnet applies a
// policy to a pod a moment after the pod started, so the job retries until
// the outside address stops answering, and fails if it keeps answering.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const namespace = `hammerkit-k8s-net-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')

const web = {
  image: 'node:24-alpine',
  shell: 'sh',
  ports: [8080],
  cmd: `node -e "require('http').createServer((req, res) => res.end('ok')).listen(8080)"`,
  healthcheck: { cmd: 'wget -q -O /dev/null http://127.0.0.1:8080', timeout: '60s' },
}
const reachWeb = 'test "$(wget -q -T 5 -O - http://web:8080)" = ok'
const noRoute = (wget = 'wget') =>
  `for i in $(seq 30); do ${wget} -q -T 2 -O /dev/null http://1.1.1.1 || exit 0; sleep 1; done; exit 1`

describe('network limits (kubernetes)', () => {
  it(
    'lets a job with network none reach the services it needs and nothing else',
    requiresKubernetes(async () => {
      await createTestCase('k8s-network-none', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace, networkPolicy: 'enforced' } } },
          services: { web },
          tasks: {
            // two jobs, so a failure names the check that failed
            reach: {
              image: 'alpine:3.21',
              src: ['input.txt'],
              network: 'none',
              needs: ['web'],
              cmds: [reachWeb],
            },
            isolated: {
              image: 'alpine:3.21',
              src: ['input.txt'],
              network: 'none',
              needs: ['web'],
              cmds: [noRoute()],
            },
            use: {
              image: 'alpine:3.21',
              deps: ['reach', 'isolated'],
              cmds: ['true'],
            },
          },
        },
        'input.txt': `${Date.now()}\n`,
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'use',
          environmentName: 'default',
        })
        await expectSuccessfulResult(await cli.runExec(), environment)
      })
    })
  )

  it(
    'sends a job with an allow list through its proxy',
    requiresKubernetes(async () => {
      await createTestCase('k8s-network-allow', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace, networkPolicy: 'enforced' } } },
          tasks: {
            install: {
              image: 'node:24-alpine',
              src: ['input.txt'],
              network: { allow: ['registry.npmjs.org'] },
              cmds: [
                [
                  'npm view left-pad version',
                  'wget -q -T 5 -O - http://example.com 2>&1 | grep -q Forbidden',
                  noRoute('env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY wget'),
                ].join(' && '),
              ],
            },
          },
        },
        'input.txt': `${Date.now()}\n`,
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'install',
          environmentName: 'default',
        })
        const result = await cli.runExec()
        if (!result.success) {
          // reports what failed
          await expectSuccessfulResult(result, environment)
        }
      })
    })
  )
})
