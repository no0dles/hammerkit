import { WorkKubernetesServer } from '../planner/work-environment'
import { LocalWorkTask } from '../planner/work-task'
import {
  getLocalTaskPool,
  getPodPlacement,
  getRunLabels,
  getRunLabelValue,
  placeOnPool,
  runInToolImage,
} from './job-placement'

const server: WorkKubernetesServer = {
  run: 'run_1',
  namespace: 'hammerkit',
  pools: [
    { name: 'amd', platform: { os: 'linux', arch: 'amd64' }, nodeSelector: {}, tolerations: [] },
    {
      name: 'amd-tools',
      platform: { os: 'linux', arch: 'amd64' },
      nodeSelector: { pool: 'tools' },
      tolerations: [{ key: 'tools', operator: 'Exists', effect: 'NoSchedule' }],
      toolImage: 'tools:amd',
    },
    {
      name: 'arm',
      platform: { os: 'linux', arch: 'arm64' },
      nodeSelector: {},
      tolerations: [],
      toolImage: 'tools:arm',
    },
  ],
  providers: {},
  accounts: {},
}

describe('job placement', () => {
  it('runs a local task in the tool image of the first pool that offers its platform', () => {
    expect(getLocalTaskPool(server, 'a', undefined).name).toBe('amd-tools')
    expect(getLocalTaskPool(server, 'a', { arch: 'arm64' }).name).toBe('arm')
    expect(getLocalTaskPool(server, 'a', { os: 'linux' }).name).toBe('amd-tools')
  })

  it('names the platform no pool offers', () => {
    expect(() => getLocalTaskPool(server, 'xcode', { os: 'macos' })).toThrow(
      'task xcode: runs on macOS, this server runs tasks on Linux nodes'
    )
    expect(() => getLocalTaskPool(server, 'a', { os: 'win' })).toThrow('runs on Windows')
    expect(() => getLocalTaskPool(server, 'a', { arch: 'arm' })).toThrow('offer amd64 and arm64')
    const noTools = { ...server, pools: [server.pools[0]] }
    expect(() => getLocalTaskPool(noTools, 'a', undefined)).toThrow(
      'task a: a local task runs in the toolImage of a pool, and no pool of this server has one'
    )
  })

  it('turns a local task into a container of the tool image, in the same directories', () => {
    const task = { name: 'lint', type: 'local-task', cwd: '/src', cmds: [] } as unknown as LocalWorkTask
    expect(runInToolImage(task, server, { arch: 'arm64' })).toEqual({
      name: 'lint',
      type: 'container-task',
      cwd: '/src',
      cmds: [],
      image: 'tools:arm',
      user: null,
      mounts: [],
      pool: 'arm',
      arch: 'arm64',
    })
    expect(runInToolImage(task, server, undefined).arch).toBe('x64')
  })

  it('keys a container task by the architecture of the first pool, where it runs', () => {
    const container = { name: 'build', type: 'container-task', image: 'alpine' } as any
    expect(placeOnPool(container, server).arch).toBe('x64')
    const arm = { ...server, pools: [server.pools[2]] }
    expect(placeOnPool(container, arm).arch).toBe('arm64')
  })

  it('places a pod on the nodes of its pool, the first by default', () => {
    expect(getPodPlacement(server, undefined)).toEqual({
      nodeSelector: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64' },
      tolerations: [],
    })
    expect(getPodPlacement(server, 'amd-tools')).toEqual({
      nodeSelector: { 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64', pool: 'tools' },
      tolerations: [{ key: 'tools', operator: 'Exists', effect: 'NoSchedule' }],
    })
  })

  it('labels what a run makes on a server only', () => {
    expect(getRunLabels({ server })).toEqual({ 'hammerkit.dev/run': getRunLabelValue('run_1') })
    expect(getRunLabels({})).toEqual({})
  })

  // https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#syntax-and-character-set
  const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/
  const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

  it('labels a run with a valid label value whatever its id starts or ends with', () => {
    // a run id is `run_` and 16 base64url characters (RUN_ID_PATTERN)
    for (const first of BASE64URL) {
      for (const last of BASE64URL) {
        const run = `run_${first}${'a'.repeat(14)}${last}`
        const value = getRunLabels({ server: { ...server, run } })['hammerkit.dev/run']
        expect(value, run).toMatch(LABEL_VALUE)
        expect(value.length).toBeLessThanOrEqual(63)
      }
    }
    expect(getRunLabelValue('run_AAAAAAAAAAAAAAA-')).not.toBe(getRunLabelValue('run_AAAAAAAAAAAAAAA_'))
  })
})
