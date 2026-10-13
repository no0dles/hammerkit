import { join } from 'path'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { expectSuccessfulResult } from '../expect'
import { KubeConfig, NetworkingV1Api } from '@kubernetes/client-node'
import { WorkItem } from '../../planner/work-item'
import { ContainerWorkService } from '../../planner/work-service'

// A limited job gets a NetworkPolicy: egress to the pods of the services it
// needs and, under `allow`, to its egress proxy. Nothing else answers, so
// the request to an outside address times out, from the first request on:
// kind's kindnet applies a policy a moment after a pod started, and the gate
// in front of the job's own containers waits for it. An open job reaching the
// same address shows the runner itself has a way out.

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
const outside = 'http://1.1.1.1'
const noRoute = (wget = 'wget') => `! ${wget} -q -T 5 -O /dev/null ${outside}`

function networkingApi(): NetworkingV1Api {
  const kc = new KubeConfig()
  kc.loadFromDefault()
  kc.setCurrentContext(context)
  return kc.makeApiClient(NetworkingV1Api)
}

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
            // the positive control
            open: {
              image: 'alpine:3.21',
              src: ['input.txt'],
              cmds: [`wget -q -T 5 -O /dev/null ${outside}`],
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
        const updates = Array.from(result.state.tasks['install'].status.read()).map((s) => `${s.level}: ${s.message}`)
        expect(updates).toContain('warn: network: refused example.com')
      })
    })
  )

  it(
    'keeps the policy of a limited service until down',
    requiresKubernetes(async () => {
      await createTestCase('k8s-network-service', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          environments: { default: { kubernetes: { context, namespace, networkPolicy: 'enforced' } } },
          services: {
            // only starts, and turns ready, when it has no way out
            web: { ...web, network: 'none', cmd: `${noRoute()} && ${web.cmd}` },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { environmentName: 'default' })
        const service = cli.services()[0].item as WorkItem<ContainerWorkService>
        const policies = async () =>
          (
            await networkingApi().listNamespacedNetworkPolicy({
              namespace,
              labelSelector: `hammerkit.dev/network-of=${service.id()}`,
            })
          ).items.map((policy) => policy.spec?.podSelector?.matchLabels)

        try {
          const up = await cli.runUp({ daemon: true })
          if (!up.success) {
            await expectSuccessfulResult(up, environment)
          }
          expect(await policies()).toEqual([{ 'hammerkit.dev/id': service.id() }])
        } finally {
          expect((await cli.runDown()).success).toBe(true)
        }
        expect(await policies()).toEqual([])
      })
    }),
    240_000
  )
})
