import { platform } from 'os'
import { getWorkTaskCacheDescription } from './work-task-cache-description'
import { ContainerWorkTask, LocalWorkTask } from '../planner/work-task'

const baseTask = {
  name: 'build',
  cwd: '/work/app',
  projectRoot: '/work',
  description: null,
  src: [{ source: 'b' }, { source: 'a' }] as any,
  generates: [{ path: '/work/app/out/b' }, { path: '/work/app/out/a' }] as any,
  envs: { variables: { B: '2', A: '1' }, replacements: [] } as any,
  cmds: [{ cwd: '/work/app/sub', cmd: 'tsc' }] as any,
  scope: {} as any,
  labels: {},
  shell: '/bin/sh',
  caching: {} as any,
  continuous: false,
  timeout: null,
  secrets: [],
}

describe('getWorkTaskCacheDescription', () => {
  it('describes a container task with image as platform, sorted mounts and project-relative paths', () => {
    const task: ContainerWorkTask = {
      ...baseTask,
      type: 'container-task',
      image: 'node:alpine',
      user: null,
      mounts: [{ mount: 'b:b' }, { mount: 'a:a' }] as any,
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
  })

  it('describes a local task with the host platform and no mounts', () => {
    const task: LocalWorkTask = { ...baseTask, type: 'local-task' }
    const d = getWorkTaskCacheDescription({ data: task, deps: [] } as any)
    expect(d.platform).toBe(platform())
    expect(d.mounts).toBeUndefined()
  })
})
