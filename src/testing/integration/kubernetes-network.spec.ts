import { join } from 'path'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { expectSuccessfulResult } from '../expect'

// A limited job gets a NetworkPolicy: egress to the pods of the services it
// needs and, under `allow`, to its egress proxy. Nothing else answers, so a
// connection to an outside address times out. A network plugin applies a policy
// to a pod a moment after it started; the pod's first init container holds it
// back until then, so every try of the job fails, not only the later ones. An
// open job reaches the same address, so the tries don't fail for another reason.

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
const noRoute = `for i in $(seq 5); do if nc -z -w 2 1.1.1.1 80; then echo "reached on try $i"; exit 1; fi; done`
const route = `for i in $(seq 30); do nc -z -w 2 1.1.1.1 80 && exit 0; sleep 1; done; exit 1`

describe('network limits (kubernetes)', () => {
  it(
    'lets a job with network none reach the services it needs and nothing else',
    requiresKubernetes(async () => {
      await createTestCase('k8s-network-none', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace } } },
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
              cmds: [noRoute],
            },
            // an open job reaches the address the others can't
            open: {
              image: 'alpine:3.21',
              src: ['input.txt'],
              cmds: [route],
            },
            use: {
              image: 'alpine:3.21',
              deps: ['reach', 'isolated', 'open'],
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
          environments: { default: { kubernetes: { context, namespace } } },
          tasks: {
            install: {
              image: 'node:24-alpine',
              src: ['input.txt'],
              network: { allow: ['registry.npmjs.org'] },
              cmds: [
                [
                  'npm view left-pad version',
                  'wget -q -T 5 -O - http://example.com 2>&1 | grep -q Forbidden',
                  noRoute,
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
