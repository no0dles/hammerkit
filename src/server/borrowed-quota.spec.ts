import { BorrowedQuotas, getBorrowedQuota, isPoolNode, Quota, readPoolRoom, Room } from './borrowed-quota'
import { getMaxQuotaIssues, serverConfigSchema } from './server-config'
import { KubernetesInstance } from '../kubernetes/kubernetes-instance'

const GI = 1024 ** 3
const quota = { 'requests.cpu': '4', 'requests.memory': '8Gi', pods: '20' }
const maxQuota = { 'requests.cpu': '12', 'requests.memory': '24Gi' }
const room = (cpu: number, memory = 64 * GI): Room => ({ cpu, memory })

describe('borrowed quota', () => {
  it('lends a caller alone on the cluster the room of the nodes, up to maxQuota', () => {
    expect(getBorrowedQuota({ quota, maxQuota, callers: 1, serviceRuns: [], room: room(16) })).toEqual({
      'requests.cpu': '12',
      'requests.memory': '24Gi',
      // what is not borrowed stays as it is
      pods: '20',
    })
    // nodes that hold less than maxQuota: what they hold
    expect(getBorrowedQuota({ quota, maxQuota, callers: 1, serviceRuns: [], room: room(10, 12 * GI) })).toEqual({
      'requests.cpu': '10000m',
      'requests.memory': '12288Mi',
      pods: '20',
    })
  })

  it('splits what no caller is promised evenly among the callers with a run executing', () => {
    // two callers are promised 8 CPU of 16, each borrows half of the rest
    expect(getBorrowedQuota({ quota, maxQuota, callers: 2, serviceRuns: [], room: room(16) })['requests.cpu']).toBe(
      '8000m'
    )
    // the service runs that are up are promised their quota
    const serviceRuns: Quota[] = [{ 'requests.cpu': '4', 'requests.memory': '4Gi' }, { cpu: '2' }]
    expect(getBorrowedQuota({ quota, maxQuota, callers: 1, serviceRuns, room: room(16) })['requests.cpu']).toBe(
      '10000m'
    )
  })

  it('never goes below the share, and lends nothing without the room of the nodes', () => {
    // the nodes hold less than the shares of three callers
    expect(getBorrowedQuota({ quota, maxQuota, callers: 3, serviceRuns: [], room: room(6, 4 * GI) })).toEqual(quota)
    expect(getBorrowedQuota({ quota, maxQuota, callers: 1, serviceRuns: [], room: undefined })).toEqual(quota)
    expect(getBorrowedQuota({ quota, maxQuota, callers: 1, serviceRuns: [], room: { memory: 64 * GI } })).toEqual({
      ...quota,
      'requests.memory': '24Gi',
    })
  })

  it('raises the limits of a resource as far of the way to maxQuota as its requests', () => {
    const limited = { 'requests.cpu': '2', 'limits.cpu': '4' }
    const max = { 'requests.cpu': '6', 'limits.cpu': '12' }
    // 2 CPU of room beyond the share: half of the way from 2 to 6, and from 4 to 12
    expect(getBorrowedQuota({ quota: limited, maxQuota: max, callers: 1, serviceRuns: [], room: room(4) })).toEqual({
      'requests.cpu': '4000m',
      'limits.cpu': '8000m',
    })
  })

  it('counts the schedulable nodes of the pools', async () => {
    const pools = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: {
        type: 'kubernetes',
        pools: [
          { name: 'build', nodeSelector: { pool: 'build' } },
          { name: 'arm', platform: { os: 'linux', arch: 'arm64' } },
        ],
      },
    }).backend as any
    const node = (labels: Record<string, string>, cpu: string, unschedulable = false) => ({
      metadata: { labels: { 'kubernetes.io/os': 'linux', ...labels } },
      spec: { unschedulable },
      status: { allocatable: { cpu, memory: '8Gi' } },
    })
    const nodes = [
      node({ 'kubernetes.io/arch': 'amd64', pool: 'build' }, '8'),
      node({ 'kubernetes.io/arch': 'arm64' }, '4'),
      // cordoned, of no pool, of another architecture
      node({ 'kubernetes.io/arch': 'amd64', pool: 'build' }, '8', true),
      node({ 'kubernetes.io/arch': 'amd64', pool: 'system' }, '2'),
      node({ 'kubernetes.io/arch': 'arm64', pool: 'build' }, '16'),
    ]
    expect(nodes.map((one) => isPoolNode(one as any, pools.pools))).toEqual([true, true, false, false, true])
    const instance = { coreApi: { listNode: async () => ({ items: nodes }) } } as unknown as KubernetesInstance
    expect(await readPoolRoom(instance, pools.pools)).toEqual({ cpu: 28, memory: 24 * GI })
  })

  describe('the quotas of the callers', () => {
    function lender(options: { room?: () => Promise<Room>; write?: (namespace: string, hard: Quota) => void } = {}) {
      const writes: string[] = []
      const logs: string[] = []
      const quotas = new BorrowedQuotas({
        quota,
        maxQuota,
        room: options.room ?? (async () => room(16)),
        write: async (namespace, hard) => {
          options.write?.(namespace, hard)
          writes.push(`${namespace} ${hard['requests.cpu']}`)
        },
        log: (line) => logs.push(line),
      })
      return { quotas, writes, logs }
    }

    it('lends to a caller alone, and gives back when a second caller needs room', async () => {
      const { quotas, writes } = lender()
      quotas.enter('hk-a', 'run_1')
      await quotas.apply('hk-a')
      expect(writes).toEqual(['hk-a 12'])
      // a second run of the same caller changes nothing, its namespace is written again
      quotas.enter('hk-a', 'run_2')
      await quotas.apply('hk-a')
      expect(writes).toEqual(['hk-a 12', 'hk-a 12'])
      writes.length = 0

      // another caller: the first one is lowered before the second one gets its quota
      quotas.enter('hk-b', 'run_3')
      await quotas.apply('hk-b')
      expect(writes).toEqual(['hk-a 8000m', 'hk-b 8000m'])
      writes.length = 0

      // their runs end: the second caller goes back to its share, the first borrows again
      await quotas.leave('hk-b', 'run_3')
      expect(writes).toEqual(['hk-b 4', 'hk-a 12'])
      writes.length = 0
      await quotas.leave('hk-a', 'run_1')
      expect(writes).toEqual([])
      await quotas.leave('hk-a', 'run_2')
      expect(writes).toEqual(['hk-a 4'])
      // a run that never entered, or left already
      await quotas.leave('hk-a', 'run_2')
      expect(writes).toEqual(['hk-a 4'])
    })

    it('keeps the room of the service runs that are up', async () => {
      const { quotas, writes } = lender()
      quotas.enter('hk-a', 'run_1')
      await quotas.apply('hk-a')
      await quotas.serviceRun('hk-preview', { 'requests.cpu': '8' })
      await quotas.serviceRunEnded('hk-preview')
      expect(writes).toEqual(['hk-a 12', 'hk-a 8000m', 'hk-a 12'])
    })

    it('lends nothing while the nodes can’t be read, and says so once', async () => {
      const { quotas, writes, logs } = lender({
        room: async () => {
          throw Object.assign(new Error('nodes is forbidden'), { code: 403 })
        },
      })
      quotas.enter('hk-a', 'run_1')
      await quotas.apply('hk-a')
      quotas.enter('hk-b', 'run_2')
      await quotas.apply('hk-b')
      expect(writes).toEqual(['hk-a 4', 'hk-b 4'])
      expect(logs).toEqual(['callers borrow no quota, the nodes could not be read: nodes is forbidden'])
    })

    it('fails the run whose quota can’t be written, and only logs the others', async () => {
      let refuse = ''
      const { quotas, logs } = lender({
        write: (namespace) => {
          if (namespace === refuse) {
            throw Object.assign(new Error(`${namespace} is forbidden`), { code: 403 })
          }
        },
      })
      quotas.enter('hk-a', 'run_1')
      await quotas.apply('hk-a')
      refuse = 'hk-a'
      quotas.enter('hk-b', 'run_2')
      await quotas.apply('hk-b')
      expect(logs).toEqual(['the quota of hk-a could not be changed: hk-a is forbidden'])
      refuse = 'hk-c'
      quotas.enter('hk-c', 'run_3')
      await expect(quotas.apply('hk-c')).rejects.toThrow('hk-c is forbidden')
      // and the next change is worked out as if nothing happened
      refuse = ''
      await quotas.leave('hk-c', 'run_3')
    })
  })

  it('takes a maxQuota of CPU and memory above the quota only', () => {
    expect(getMaxQuotaIssues(quota, undefined)).toEqual([])
    expect(getMaxQuotaIssues(quota, maxQuota)).toEqual([])
    expect(getMaxQuotaIssues(undefined, maxQuota)).toEqual([
      { path: [], message: 'a caller borrows above backend.quota, which is not set' },
    ])
    expect(
      getMaxQuotaIssues(
        { ...quota, 'limits.cpu': '8' },
        { 'requests.cpu': '2', 'requests.memory': '16Gi', 'limits.memory': '32Gi', 'limits.cpu': '16', pods: '40' }
      ).map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    ).toEqual([
      'requests.cpu: 2 is less than 4 of backend.quota',
      'limits.memory: limits.memory is not in backend.quota, the share it rises from',
      "pods: pods can't be borrowed, only requests.cpu, cpu, limits.cpu, requests.memory, memory, limits.memory",
    ])
    expect(
      getMaxQuotaIssues({ 'requests.cpu': '2', 'limits.cpu': '4' }, { 'limits.cpu': '8' }).map((issue) => issue.message)
    ).toEqual(['limits.cpu rises with the requests of cpu, add requests.cpu to backend.maxQuota'])
    // as the config reads it
    const parsed = serverConfigSchema.safeParse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      backend: { type: 'kubernetes', quota: { 'requests.cpu': 4 }, maxQuota: { 'requests.cpu': 2 } },
    })
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual([
      'backend.maxQuota.requests.cpu',
    ])
  })
})
