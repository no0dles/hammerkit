import { join } from 'path'
import { createServer, get, Server } from 'http'
import { AddressInfo } from 'net'
import { networkInterfaces } from 'os'
import Dockerode, { Container } from 'dockerode'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { expectSuccessfulResult } from '../expect'
import { getItemNetworkName } from '../../docker/item-network'
import { WorkItem } from '../../planner/work-item'
import { ContainerWorkTask } from '../../planner/work-task'
import { ContainerWorkService } from '../../planner/work-service'
import { getWorkInstanceId } from '../../planner/work-instance-id'

const image = 'alpine:3.21'
// nothing but the loopback interface: no way out at all
const noInterfaces = 'test "$(ls /sys/class/net)" = lo'
// no route to an address outside, whatever DNS says
const noRoute = '! wget -q -T 3 -O /dev/null http://1.1.1.1'
const noRouteWithoutProxy =
  '! env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY wget -q -T 3 -O /dev/null http://1.1.1.1'
// a web server the tasks reach by name
const web = {
  image: 'node:24-alpine',
  shell: 'sh',
  cmd: `node -e "require('http').createServer((req, res) => res.end('ok')).listen(8080)"`,
  healthcheck: { cmd: 'wget -q -O /dev/null http://127.0.0.1:8080', timeout: '30s' },
}
// A client that knows no proxy, by the host's own name. Its stdin stays open
// until the answer is in, and the answer is printed, so a failure shows it.
const queryExample =
  'grep example.com /etc/hosts; ' +
  "(printf 'HEAD / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n'; sleep 5) | nc -w 10 example.com 80 > /tmp/answer; " +
  "cat /tmp/answer; grep -q '^HTTP/1' /tmp/answer"
const reachWeb = (name: string) => `test "$(wget -q -T 5 -O - http://${name}:8080)" = ok`

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  return (server.address() as AddressInfo).port
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve(body))
    }).on('error', reject)
  })
}

// the exit code of a command run in a container
async function execIn(container: Container, cmd: string[]): Promise<number> {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
  const stream = await exec.start({})
  await new Promise((resolve) => {
    stream.on('end', resolve)
    stream.resume()
  })
  return (await exec.inspect()).ExitCode ?? -1
}

async function waitFor<T>(find: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const found = await find()
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('not found in time')
}

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
    'forwards raw TCP to a host and port of the allow list, and nothing else',
    requiresLinuxContainers(async () => {
      await createTestCase('network-docker-forward', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            query: {
              image,
              network: { allow: ['example.com:80'] },
              cmds: [
                queryExample,
                // another port of that host goes nowhere
                '! nc -w 3 example.com 443 </dev/null',
                noRouteWithoutProxy,
              ],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'query' })
        await expectSuccessfulResult(await cli.runExec(), environment)
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
          // the service's network and the one only it and its proxy join
          expect(await docker.listNetworks({ filters: { name: [name] } })).toHaveLength(2)
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
    'keeps limited containers off the host, through any of its addresses',
    requiresLinuxContainers(async () => {
      const host = createServer((req, res) => res.end('host'))
      const port = await listen(host)
      const hostAddresses = Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .filter((address) => address.family === 'IPv4')
        .map((address) => address.address)
      // every address of the host, and the gateway an internal network has on
      // it (the first address of the container's subnet), without the proxy
      const offTheHost = [
        `for ip in ${hostAddresses.join(
          ' '
        )} $(ip -4 -o addr show | awk '$2 != "lo" {split($4, a, "/"); split(a[1], o, "."); print o[1] "." o[2] "." o[3] ".1"}'); do`,
        `if env -u http_proxy -u HTTP_PROXY wget -q -T 2 -O /dev/null http://$ip:${port}; then echo "reached the host at $ip"; exit 1; fi;`,
        'done',
      ].join(' ')
      try {
        await createTestCase('network-docker-host', {
          '.git/HEAD': 'ref: refs/heads/main\n',
          '.hammerkit.yaml': {
            services: { web },
            tasks: {
              isolated: { image, network: 'none', needs: ['web'], cmds: [reachWeb('web'), offTheHost] },
              proxied: { image, network: { allow: ['registry.npmjs.org'] }, cmds: [offTheHost] },
              check: { image, deps: ['isolated', 'proxied'], cmds: ['true'] },
            },
          },
        }).setup(async (cwd, environment) => {
          expect(await fetchText(`http://127.0.0.1:${port}`)).toBe('host')
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'check' })
          await expectSuccessfulResult(await cli.runExec(), environment)
        })
      } finally {
        await new Promise<void>((resolve) => host.close(() => resolve()))
      }
    }),
    180_000
  )

  it(
    'keeps the proxy of a task from the services it needs',
    requiresLinuxContainers(async () => {
      await createTestCase('network-docker-own-proxy', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            quiet: {
              image: 'node:24-alpine',
              shell: 'sh',
              network: 'none',
              cmd: 'node -e "setInterval(() => {}, 1e6)"',
            },
          },
          tasks: {
            install: { image, network: { allow: ['registry.npmjs.org'] }, needs: ['quiet'], cmds: ['sleep 20'] },
          },
        },
      }).setup(async (cwd, environment) => {
        const docker = new Dockerode()
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'install' })
        const task = cli.tasks()[0].item as WorkItem<ContainerWorkTask>
        const service = cli.services()[0].item as WorkItem<ContainerWorkService>
        const run = cli.runExec()

        const proxy = await waitFor(async () => {
          const found = await docker.listContainers({
            filters: { label: [`hammerkit-network=${getItemNetworkName(task)}`], status: ['running'] },
          })
          return found[0]
        })
        const quiet = await waitFor(async () => {
          const found = await docker.listContainers({
            filters: { label: [`hammerkit-id=${getWorkInstanceId(service)}`], status: ['running'] },
          })
          return found[0]
        })
        const addresses = Object.values((await docker.getContainer(proxy.Id).inspect()).NetworkSettings.Networks)
          .map((network) => network.IPAddress)
          .filter((address) => !!address)
        expect(addresses.length).toBeGreaterThan(0)
        // the proxy by its name and by each of its addresses
        for (const target of ['hammerkit-proxy', ...addresses]) {
          const reached = await execIn(docker.getContainer(quiet.Id), [
            'node',
            '-e',
            `require('net').connect(3128, '${target}').on('connect', () => process.exit(0)).on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 2000)`,
          ])
          expect({ target, reached: reached === 0 }).toEqual({ target, reached: false })
        }
        await expectSuccessfulResult(await run, environment)
      })
    }),
    180_000
  )

  it(
    'publishes the ports of a limited service',
    requiresLinuxContainers(async () => {
      const free = createServer()
      const port = await listen(free)
      await new Promise<void>((resolve) => free.close(() => resolve()))
      await createTestCase('network-docker-ports', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: { site: { ...web, network: 'none', ports: [`${port}:8080`] } },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
        try {
          expect((await cli.runUp({ daemon: true })).success).toBe(true)
          expect(await fetchText(`http://127.0.0.1:${port}`)).toBe('ok')
        } finally {
          expect((await cli.runDown()).success).toBe(true)
        }
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
