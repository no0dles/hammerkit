import Dockerode from 'dockerode'
import { hostname } from 'os'
import { checkNetworkLimitSupport, removeItemNetwork, removeOrphanedNetworks } from './item-network'

function fakeDocker(networks: { [name: string]: { labels: { [key: string]: string }; containers: string[] } }) {
  const removed: string[] = []
  const disconnected: string[] = []
  const docker = {
    listContainers: vi.fn().mockResolvedValue([]),
    listNetworks: vi.fn().mockResolvedValue(Object.entries(networks).map(([Name, n]) => ({ Name, Labels: n.labels }))),
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!networks[name]) {
          throw Object.assign(new Error('not found'), { statusCode: 404 })
        }
        return { Containers: Object.fromEntries(networks[name].containers.map((id) => [id, {}])) }
      },
      disconnect: async ({ Container }: { Container: string }) => {
        disconnected.push(`${name}/${Container}`)
      },
      remove: async () => {
        removed.push(name)
      },
    }),
  } as unknown as Dockerode
  return { docker, removed, disconnected }
}

// a pid that no process on this machine has
const deadPid = '2147483646'

describe('item network', () => {
  it('disconnects every endpoint before it removes the network', async () => {
    const { docker, removed, disconnected } = fakeDocker({ net: { labels: {}, containers: ['a', 'b'] } })
    await removeItemNetwork(docker, 'net')
    expect(disconnected).toEqual(['net/a', 'net/b'])
    expect(removed).toEqual(['net'])
  })

  it('takes a missing network as removed', async () => {
    const { docker, removed } = fakeDocker({})
    await removeItemNetwork(docker, 'net')
    expect(removed).toEqual([])
  })

  it('removes the networks of stopped runs on this machine, not those of daemon services', async () => {
    const run = { app: 'hammerkit', 'hammerkit-host': hostname(), 'hammerkit-pid': deadPid }
    const { docker, removed } = fakeDocker({
      stopped: { labels: { ...run, 'hammerkit-daemon': 'false' }, containers: [] },
      daemon: { labels: { ...run, 'hammerkit-daemon': 'true' }, containers: [] },
      running: { labels: { ...run, 'hammerkit-pid': `${process.pid}`, 'hammerkit-daemon': 'false' }, containers: [] },
      elsewhere: { labels: { ...run, 'hammerkit-host': 'other', 'hammerkit-daemon': 'false' }, containers: [] },
    })
    expect(await removeOrphanedNetworks(docker)).toEqual(['stopped'])
    expect(removed).toEqual(['stopped'])
  })

  it('removes nothing without a docker daemon', async () => {
    const docker = {
      listNetworks: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('no daemon'), { syscall: 'connect', code: 'ENOENT' })),
    } as unknown as Dockerode
    expect(await removeOrphanedNetworks(docker)).toEqual([])
  })

  describe('daemon support', () => {
    const item = (type: 'none' | 'open') =>
      ({ name: 'build', data: { network: { type }, networkCeiling: null } }) as any
    const daemon = (Version: string, Os = 'linux') => ({ version: vi.fn().mockResolvedValue({ Version, Os }) }) as any

    it('takes Linux containers on Docker 28 or later', async () => {
      await expect(checkNetworkLimitSupport(daemon('28.0.0'), item('none'))).resolves.toBeUndefined()
      await expect(checkNetworkLimitSupport(daemon('29.8.2'), item('none'))).resolves.toBeUndefined()
    })

    it('refuses an older daemon, naming the version it needs', async () => {
      await expect(checkNetworkLimitSupport(daemon('27.5.1'), item('none'))).rejects.toThrow(
        'build: network none needs Docker 28 or later, the daemon is 27.5.1'
      )
      await expect(checkNetworkLimitSupport(daemon('dev'), item('none'))).rejects.toThrow('needs Docker 28 or later')
    })

    it('refuses Windows containers', async () => {
      await expect(checkNetworkLimitSupport(daemon('28.1.0', 'windows'), item('none'))).rejects.toThrow(
        'build: network none needs Linux containers, the docker daemon runs windows containers'
      )
    })

    it('asks the daemon once', async () => {
      const docker = daemon('28.0.0')
      await checkNetworkLimitSupport(docker, item('none'))
      await checkNetworkLimitSupport(docker, item('none'))
      expect(docker.version).toHaveBeenCalledTimes(1)
    })
  })
})
