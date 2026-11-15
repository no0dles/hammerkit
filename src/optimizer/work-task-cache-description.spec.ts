import { platform } from 'os'
import {
  getWorkServiceCacheIdentity,
  getWorkTaskCacheDescription,
  storedCacheDescription,
} from './work-task-cache-description'
import { getWorkTaskId } from '../planner/work-cache-id'
import { WorkSecret } from '../planner/work-secret'
import { ContainerWorkTask, LocalWorkTask } from '../planner/work-task'

const baseTask = {
  name: 'build',
  cwd: '/work/app',
  projectRoot: '/work',
  description: null,
  src: [
    { source: 'b', absolutePath: '/work/app/b.ts', inherited: null },
    { source: 'a', absolutePath: '/work/app/a.ts', inherited: null },
  ] as any,
  generates: [
    { path: '/work/app/out/b', inherited: null },
    { path: '/work/app/out/a', inherited: null },
  ] as any,
  envs: { variables: { B: '2', A: '1' }, replacements: [] } as any,
  envOrigins: {},
  cmds: [{ cwd: '/work/app/sub', cmd: 'tsc' }] as any,
  scope: {} as any,
  labels: {},
  shell: '/bin/sh',
  caching: {} as any,
  timeout: null,
  secrets: [],
  resources: null,
  network: { type: 'open' as const },
  networkCeiling: null,
  runner: null,
  args: null,
}

describe('getWorkTaskCacheDescription', () => {
  it('describes a container task with image as platform, sorted mounts and project-relative paths', () => {
    const task: ContainerWorkTask = {
      ...baseTask,
      type: 'container-task',
      image: 'node:alpine',
      user: null,
      mounts: [
        { mount: 'b:b', containerPath: '/work/app/mb' },
        { mount: 'a:a', containerPath: '/work/app/ma' },
      ] as any,
      volumeSize: null,
      capAdd: [],
    }
    const d = getWorkTaskCacheDescription({ data: task, deps: [], needs: [] } as any)
    expect(d.platform).toBe('node:alpine')
    expect(d.mounts).toEqual(['a:a', 'b:b'])
    expect(d.src).toEqual(['a', 'b'])
    expect(d.generates).toEqual(['app/out/a', 'app/out/b'])
    expect(Object.keys(d.envs!)).toEqual(['A', 'B']) // sorted
    expect(d.cmds).toEqual([{ cwd: 'app/sub', cmd: 'tsc' }])
    expect(d.cwd).toBe('app')
    expect(d.shell).toBe('/bin/sh')
    expect(d.claimLayout).toBeUndefined()
  })

  it('gives a task with two paths that end alike a new id, which leaves what it made in one folder behind', () => {
    const task: ContainerWorkTask = {
      ...baseTask,
      type: 'container-task',
      image: 'node:alpine',
      user: null,
      mounts: [],
      volumeSize: null,
      capAdd: [],
      generates: [
        { path: '/work/app/node_modules', inherited: null },
        { path: '/work/app/api/node_modules', inherited: null },
      ] as any,
    }
    expect(getWorkTaskCacheDescription({ data: task, deps: [], needs: [] } as any).claimLayout).toBe(2)
    // an output of a dep it mounts is in the dep's claim, not in its own
    const inherited = { ...task, generates: [task.generates[0], { ...task.generates[1], inherited: {} }] }
    expect(getWorkTaskCacheDescription({ data: inherited, deps: [], needs: [] } as any).claimLayout).toBeUndefined()
    // a source shares the claim with the outputs
    const source = { ...task, generates: [task.generates[0]], src: [{ absolutePath: '/work/node_modules' }] as any }
    expect(getWorkTaskCacheDescription({ data: source, deps: [], needs: [] } as any).claimLayout).toBe(2)
    // two outputs that shared one cache archive
    const flat = {
      ...task,
      generates: [
        { path: '/work/app/a-b', inherited: null },
        { path: '/work/app/a/b', inherited: null },
      ] as any,
    }
    expect(getWorkTaskCacheDescription({ data: flat, deps: [], needs: [] } as any).claimLayout).toBe(2)
  })

  it('describes a local task with the host platform and no mounts', () => {
    const task: LocalWorkTask = { ...baseTask, type: 'local-task' }
    const d = getWorkTaskCacheDescription({ data: task, deps: [], needs: [] } as any)
    expect(d.platform).toBe(platform())
    expect(d.mounts).toBeUndefined()
  })
})

describe('the secrets of a task in its cache description', () => {
  const local = (secrets: WorkSecret[]): LocalWorkTask => ({ ...baseTask, type: 'local-task', secrets })
  const describeTask = (secrets: WorkSecret[]) =>
    getWorkTaskCacheDescription({ data: local(secrets), deps: [], needs: [] } as any)
  const provider = (ref: string, account = 'deploy'): WorkSecret => ({
    source: { type: 'provider', provider: 'gcp', ref, account, binding: {} as any },
    target: { type: 'env', name: 'TOKEN' },
    cache: false,
    digest: () => {
      throw new Error('a secret without cache: true is never read for the key')
    },
  })

  it('names a secret without cache: true and where it comes from, never its value', () => {
    expect(describeTask([provider('deploy-key')]).secretSources).toEqual(['TOKEN<gcp:deploy-key as deploy'])
    expect(describeTask([]).secretSources).toBeUndefined()
  })

  it('gives a task another id than its twin that reads no secret, or reads it from elsewhere', () => {
    const id = (secrets: WorkSecret[]) => getWorkTaskId({ data: local(secrets), deps: [], needs: [] } as any)
    expect(id([provider('deploy-key')])).not.toBe(id([]))
    expect(id([provider('deploy-key')])).not.toBe(id([provider('other-key')]))
    expect(id([provider('deploy-key')])).not.toBe(id([provider('deploy-key', 'dev')]))
    const env: WorkSecret = { ...provider('x'), source: { type: 'env', name: 'NPM_TOKEN' } }
    expect(describeTask([env]).secretSources).toEqual(['TOKEN<env:NPM_TOKEN'])
    // a file of the machine is named apart from its path, which differs between machines
    const file = (path: string): WorkSecret => ({ ...provider('x'), source: { type: 'file', path } })
    expect(describeTask([file('/home/a/.npmrc')]).secretSources).toEqual(['TOKEN<file'])
    expect(id([file('/home/a/.npmrc')])).toBe(id([file('/Users/b/.npmrc')]))
  })

  it('stores where the secrets come from as digests', () => {
    const stored = storedCacheDescription(describeTask([provider('deploy-key')]))
    expect(stored.secretSources).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{64}$/)])
    expect(JSON.stringify(stored)).not.toContain('deploy-key')
  })
})

describe('the secrets of a service in what a task that needs it is keyed by', () => {
  const service = (secrets: WorkSecret[]) =>
    ({
      name: 'db',
      deps: [],
      needs: [],
      data: {
        type: 'container-service',
        name: 'db',
        cwd: '/work',
        projectRoot: '/work',
        image: 'postgres:16',
        volumes: [],
        src: [],
        mounts: [],
        ports: [],
        envs: { variables: {}, replacements: [] },
        cmd: null,
        healthcheck: null,
        init: null,
        workdir: null,
        shell: null,
        secrets,
      },
    }) as any
  const password: WorkSecret = {
    source: { type: 'env', name: 'DB_PASSWORD' },
    target: { type: 'env', name: 'POSTGRES_PASSWORD' },
    cache: false,
    digest: () => {
      throw new Error('never read for the key')
    },
  }

  it('names the secrets of a needed service, and leaves the identity of one without any as it was', () => {
    expect(getWorkServiceCacheIdentity(service([password]))).not.toBe(getWorkServiceCacheIdentity(service([])))
    const other: WorkSecret = { ...password, source: { type: 'env', name: 'OTHER' } }
    expect(getWorkServiceCacheIdentity(service([password]))).not.toBe(getWorkServiceCacheIdentity(service([other])))
  })
})
