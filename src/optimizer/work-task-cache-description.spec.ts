import { platform } from 'os'
import { getWorkTaskCacheDescription } from './work-task-cache-description'
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
  continuous: false,
  timeout: null,
  secrets: [],
  resources: null,
  network: { type: 'open' as const },
  networkCeiling: null,
  runner: null,
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
    }
    const d = getWorkTaskCacheDescription({ data: task, deps: [] } as any)
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
      generates: [
        { path: '/work/app/node_modules', inherited: null },
        { path: '/work/app/api/node_modules', inherited: null },
      ] as any,
    }
    expect(getWorkTaskCacheDescription({ data: task, deps: [] } as any).claimLayout).toBe(2)
    // an output of a dep it mounts is in the dep's claim, not in its own
    const inherited = { ...task, generates: [task.generates[0], { ...task.generates[1], inherited: {} }] }
    expect(getWorkTaskCacheDescription({ data: inherited, deps: [] } as any).claimLayout).toBeUndefined()
    // a source shares the claim with the outputs
    const source = { ...task, generates: [task.generates[0]], src: [{ absolutePath: '/work/node_modules' }] as any }
    expect(getWorkTaskCacheDescription({ data: source, deps: [] } as any).claimLayout).toBe(2)
    // two outputs that shared one cache archive
    const flat = {
      ...task,
      generates: [
        { path: '/work/app/a-b', inherited: null },
        { path: '/work/app/a/b', inherited: null },
      ] as any,
    }
    expect(getWorkTaskCacheDescription({ data: flat, deps: [] } as any).claimLayout).toBe(2)
  })

  it('describes a local task with the host platform and no mounts', () => {
    const task: LocalWorkTask = { ...baseTask, type: 'local-task' }
    const d = getWorkTaskCacheDescription({ data: task, deps: [] } as any)
    expect(d.platform).toBe(platform())
    expect(d.mounts).toBeUndefined()
  })
})
