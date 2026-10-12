import { join } from 'path'
import Dockerode from 'dockerode'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { expectSuccessfulResult } from '../expect'
import { getItemNetworkName } from '../../docker/item-network'
import { WorkItem } from '../../planner/work-item'
import { ContainerWorkTask } from '../../planner/work-task'
import { ContainerWorkService } from '../../planner/work-service'

const image = 'alpine:3.21'
// nothing but the loopback interface: no way out at all
const noInterfaces = 'test "$(ls /sys/class/net)" = lo'
// no route to an address outside, whatever DNS says
const noRoute = '! wget -q -T 3 -O /dev/null http://1.1.1.1'
const noRouteWithoutProxy = '! env -u http_proxy -u HTTP_PROXY wget -q -T 3 -O /dev/null http://1.1.1.1'
// a web server the tasks reach by name
const web = {
  image: 'node:24-alpine',
  shell: 'sh',
  cmd: `node -e "require('http').createServer((req, res) => res.end('ok')).listen(8080)"`,
  healthcheck: { cmd: 'wget -q -O /dev/null http://127.0.0.1:8080', timeout: '30s' },
}
const reachWeb = (name: string) => `test "$(wget -q -T 5 -O - http://${name}:8080)" = ok`

describe('network limits (docker)', () => {
  it(
    'leaves a task with network none and no needs without any interface',
    requiresLinuxContainers(async () => {
      await createTestCase('network-docker-none', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            offline: { image, network: 'none', cmds: [noInterfaces] },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'offline' })
        await expectSuccessfulResult(await cli.runExec(), environment)
      })
    }),
    120_000
  )

  it(
    'reaches the services a task needs under network none, by the name it needs them by',
    requiresLinuxContainers(async () => {
      await createTestCase('network-docker-none-needs', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: { web },
          tasks: {
            use: {
              image,
              network: 'none',
              needs: [{ name: 'site', service: 'web' }],
              cmds: [reachWeb('site'), noRoute],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'use' })
        await expectSuccessfulResult(await cli.runExec(), environment)
        // the task's network is gone with the run
        const task = cli.tasks()[0].item as WorkItem<ContainerWorkTask>
        const networks = await new Dockerode().listNetworks({ filters: { name: [getItemNetworkName(task)] } })
        expect(networks).toEqual([])
      })
    }),
    120_000
  )

  it(
    'keeps a service with network none reachable for an open task',
    requiresLinuxContainers(async () => {
      await createTestCase('network-docker-service-none', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            web: { ...web, network: 'none', cmd: `${noRoute} && ${web.cmd}` },
          },
          tasks: {
            use: { image, needs: ['web'], cmds: [reachWeb('web')] },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'use' })
        await expectSuccessfulResult(await cli.runExec(), environment)
      })
    }),
    120_000
  )

  it(
    'sends a task with an allow list through the proxy, which refuses other hosts',
    requiresLinuxContainers(async () => {
      await createTestCase('network-docker-allow', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: { web },
          tasks: {
            install: {
              image: 'node:24-alpine',
              network: { allow: ['registry.npmjs.org'] },
              needs: ['web'],
              cmds: [
                // the allowed host, through the proxy variables npm reads
                'npm view left-pad version',
                // anything else is refused by the proxy
                'wget -q -T 5 -O - http://example.com 2>&1 | grep -q Forbidden',
                // the needed service is reached directly
                reachWeb('web'),
                // a tool that ignores the proxy finds no route out
                noRouteWithoutProxy,
              ],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'install' })
        const result = await cli.runExec()
        if (!result.success) {
          // reports what failed
          await expectSuccessfulResult(result, environment)
        }
        const updates = Array.from(result.state.tasks['install'].status.read()).map((s) => `${s.level}: ${s.message}`)
        expect(updates).toContain('warn: network: refused example.com')
      })
    }),
    180_000
  )

  it(
    'keeps the network and proxy of a daemon service until down',
    requiresLinuxContainers(async () => {
      await createTestCase('network-docker-daemon', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            // only starts, and turns healthy, when the proxy refuses other hosts
            api: {
              ...web,
              network: { allow: ['registry.npmjs.org'] },
              cmd: `wget -q -T 5 -O - http://example.com 2>&1 | grep -q Forbidden && ${web.cmd}`,
            },
          },
        },
      }).setup(async (cwd, environment) => {
        const docker = new Dockerode()
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
        const service = cli.services()[0].item as WorkItem<ContainerWorkService>
        const name = getItemNetworkName(service)
        const proxies = () => docker.listContainers({ all: true, filters: { label: [`hammerkit-network=${name}`] } })

        try {
          const up = await cli.runUp({ daemon: true })
          expect(up.success).toBe(true)
          const updates = Array.from(up.state.services['api'].status.read()).map((s) => `${s.level}: ${s.message}`)
          expect(updates).toContain('warn: network: refused example.com')
          expect(await docker.listNetworks({ filters: { name: [name] } })).toHaveLength(1)
          expect(await proxies()).toHaveLength(1)
        } finally {
          expect((await cli.runDown()).success).toBe(true)
        }
        expect(await docker.listNetworks({ filters: { name: [name] } })).toEqual([])
        expect(await proxies()).toEqual([])
      })
    }),
    120_000
  )

  it(
    'limits every task of a run under --network none',
    requiresLinuxContainers(async () => {
      await createTestCase('network-docker-ceiling', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            open: { image, cmds: [noInterfaces] },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'open' })
        await expectSuccessfulResult(await cli.runExec({ network: { type: 'none' } }), environment)
      })
    }),
    120_000
  )
})
