import { checkIfContextExists, hasDependencyCycle, hasMixedCycle, hasNeedCycle, validate } from './validate'
import { WorkItemNeed, WorkItemState } from './work-item'
import { KubernetesWorkService, WorkService } from './work-service'
import { WorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { ServiceState } from '../executer/scheduler/service-state'
import { WorkTree } from './work-tree'
import { WorkItemValidation } from './work-item-validation'
import { Environment } from '../executer/environment'

type AnyItem = WorkItemState<WorkTask, TaskState> | WorkItemState<WorkService, ServiceState>

function makeTask(name: string): WorkItemState<WorkTask, TaskState> {
  const item = {
    id: () => name,
    name,
    status: {} as any,
    data: { type: 'local-task', name } as any,
    needs: [] as WorkItemNeed[],
    deps: [] as WorkItemState<WorkTask, TaskState>[],
    requiredBy: [] as AnyItem[],
    state: {} as any,
    runtime: {} as any,
  }
  return item as WorkItemState<WorkTask, TaskState>
}

function makeService(name: string): WorkItemState<WorkService, ServiceState> {
  const item = {
    id: () => name,
    name,
    status: {} as any,
    data: { type: 'container-service', name } as any,
    needs: [] as WorkItemNeed[],
    deps: [] as WorkItemState<WorkTask, TaskState>[],
    requiredBy: [] as AnyItem[],
    state: {} as any,
    runtime: {} as any,
  }
  return item as WorkItemState<WorkService, ServiceState>
}

describe('validate', () => {
  describe('hasDependencyCycle', () => {
    it('returns null for an item with no deps', () => {
      const t = makeTask('a')
      expect(hasDependencyCycle(t, [])).toBeNull()
    })

    it('returns null for a linear chain', () => {
      const a = makeTask('a')
      const b = makeTask('b')
      const c = makeTask('c')
      a.deps.push(b)
      b.deps.push(c)
      expect(hasDependencyCycle(a, [])).toBeNull()
    })

    it('detects a direct self-cycle', () => {
      const a = makeTask('a')
      a.deps.push(a)
      const cycle = hasDependencyCycle(a, [])
      expect(cycle).not.toBeNull()
      expect(cycle!.map((i) => i.name)).toEqual(['a', 'a'])
    })

    it('detects an indirect cycle', () => {
      const a = makeTask('a')
      const b = makeTask('b')
      const c = makeTask('c')
      a.deps.push(b)
      b.deps.push(c)
      c.deps.push(a)
      const cycle = hasDependencyCycle(a, [])
      expect(cycle).not.toBeNull()
      expect(cycle!.map((i) => i.name)).toEqual(['a', 'b', 'c', 'a'])
    })

    it('does not flag a diamond as a cycle', () => {
      const root = makeTask('root')
      const left = makeTask('left')
      const right = makeTask('right')
      const leaf = makeTask('leaf')
      root.deps.push(left, right)
      left.deps.push(leaf)
      right.deps.push(leaf)
      expect(hasDependencyCycle(root, [])).toBeNull()
    })
  })

  describe('hasNeedCycle', () => {
    it('returns null when no needs', () => {
      const s = makeService('db')
      expect(hasNeedCycle(s, [])).toBeNull()
    })

    it('detects a need cycle across services', () => {
      const a = makeService('a')
      const b = makeService('b')
      a.needs.push({ name: 'b', service: b })
      b.needs.push({ name: 'a', service: a })
      const cycle = hasNeedCycle(a, [])
      expect(cycle).not.toBeNull()
      expect(cycle!.map((i) => i.name)).toEqual(['a', 'b', 'a'])
    })

    it('detects a self-need cycle', () => {
      const a = makeService('a')
      a.needs.push({ name: 'a', service: a })
      const cycle = hasNeedCycle(a, [])
      expect(cycle).not.toBeNull()
      expect(cycle!.map((i) => i.name)).toEqual(['a', 'a'])
    })
  })

  describe('hasMixedCycle', () => {
    it('returns null for an acyclic task → service → task chain', () => {
      const t1 = makeTask('build')
      const s = makeService('db')
      const t2 = makeTask('migrate')
      t1.needs.push({ name: 'db', service: s })
      s.deps.push(t2)
      expect(hasMixedCycle(t1, [])).toBeNull()
    })

    it('detects a cycle that alternates deps and needs', () => {
      const t = makeTask('api-build')
      const s = makeService('api')
      t.needs.push({ name: 'api', service: s })
      s.deps.push(t)
      const cycle = hasMixedCycle(t, [])
      expect(cycle).not.toBeNull()
      expect(cycle!.map((i) => i.name)).toEqual(['api-build', 'api', 'api-build'])
    })

    it('detects a long mixed cycle', () => {
      const a = makeTask('a')
      const b = makeService('b')
      const c = makeTask('c')
      const d = makeService('d')
      a.needs.push({ name: 'b', service: b })
      b.deps.push(c)
      c.needs.push({ name: 'd', service: d })
      d.deps.push(a)
      const cycle = hasMixedCycle(a, [])
      expect(cycle).not.toBeNull()
      expect(cycle!.map((i) => i.name)).toEqual(['a', 'b', 'c', 'd', 'a'])
    })
  })
})

function taskItem(name: string, data: Partial<WorkTask>): WorkItemState<WorkTask, TaskState> {
  const item = {
    id: () => name,
    name,
    status: {} as any,
    data: { type: 'local-task', name, description: 'a task', cmds: [{} as any], src: [], ...data } as any,
    needs: [] as WorkItemNeed[],
    deps: [] as WorkItemState<WorkTask, TaskState>[],
    requiredBy: [] as any[],
    state: {} as any,
    runtime: {} as any,
  }
  return item as WorkItemState<WorkTask, TaskState>
}

function serviceItem(name: string, data: Partial<WorkService>): WorkItemState<WorkService, ServiceState> {
  const item = {
    id: () => name,
    name,
    status: {} as any,
    data: { type: 'container-service', name, description: 'a service', healthcheck: {}, mounts: [], ...data } as any,
    needs: [] as WorkItemNeed[],
    deps: [] as WorkItemState<WorkTask, TaskState>[],
    requiredBy: [] as any[],
    state: {} as any,
    runtime: {} as any,
  }
  return item as WorkItemState<WorkService, ServiceState>
}

function workTree(items: {
  tasks?: WorkItemState<WorkTask, TaskState>[]
  services?: WorkItemState<WorkService, ServiceState>[]
}): WorkTree {
  return {
    tasks: Object.fromEntries((items.tasks ?? []).map((t) => [t.name, t])),
    services: Object.fromEntries((items.services ?? []).map((s) => [s.name, s])),
    environment: {} as any,
  }
}

// Environment whose file.exists only returns true for the listed paths.
function fakeEnv(existing: string[] = []): Environment {
  return { file: { exists: vi.fn(async (p: string) => existing.includes(p)) } } as unknown as Environment
}

async function collect(gen: AsyncGenerator<WorkItemValidation>): Promise<WorkItemValidation[]> {
  const out: WorkItemValidation[] = []
  for await (const v of gen) {
    out.push(v)
  }
  return out
}

describe('validate (generator)', () => {
  it('warns about a task without a description', async () => {
    const tree = workTree({ tasks: [taskItem('build', { description: null })] })
    const result = await collect(validate(tree, fakeEnv()))
    expect(result).toContainEqual(expect.objectContaining({ type: 'warn', message: 'missing description' }))
  })

  it('warns about an empty task (no cmds and no deps)', async () => {
    const tree = workTree({ tasks: [taskItem('noop', { cmds: [] })] })
    const result = await collect(validate(tree, fakeEnv()))
    expect(result).toContainEqual(expect.objectContaining({ type: 'warn', message: 'task is empty' }))
  })

  it('warns about a missing src path', async () => {
    const tree = workTree({ tasks: [taskItem('build', { src: [{ absolutePath: '/nope' } as any] })] })
    const result = await collect(validate(tree, fakeEnv([])))
    expect(result).toContainEqual(expect.objectContaining({ type: 'warn', message: 'src /nope does not exist' }))
  })

  it('does not warn when the src path exists', async () => {
    const tree = workTree({ tasks: [taskItem('build', { src: [{ absolutePath: '/yes' } as any] })] })
    const result = await collect(validate(tree, fakeEnv(['/yes'])))
    expect(result.map((r) => r.message)).not.toContain('src /yes does not exist')
  })

  it('emits a cycle error through the generator', async () => {
    const a = taskItem('a', {})
    a.deps.push(a)
    const tree = workTree({ tasks: [a] })
    const result = await collect(validate(tree, fakeEnv()))
    expect(result).toContainEqual(expect.objectContaining({ type: 'error', message: 'task cycle detected a -> a' }))
  })

  it('warns about a container service missing a healthcheck', async () => {
    const tree = workTree({ services: [serviceItem('db', { healthcheck: null })] })
    const result = await collect(validate(tree, fakeEnv()))
    expect(result).toContainEqual(expect.objectContaining({ type: 'warn', message: 'missing healthcheck' }))
  })

  it('warns about a container service mount that does not exist', async () => {
    const tree = workTree({
      services: [serviceItem('db', { mounts: [{ localPath: '/data' } as any] })],
    })
    const result = await collect(validate(tree, fakeEnv([])))
    expect(result).toContainEqual(expect.objectContaining({ type: 'warn', message: 'mount /data does not exist' }))
  })

  it('warns when a kubernetes service kubeconfig is missing', async () => {
    const tree = workTree({
      services: [
        serviceItem('cluster', {
          type: 'kubernetes-service',
          kubeconfig: '/missing/kubeconfig',
          context: 'prod',
        } as any),
      ],
    })
    const result = await collect(validate(tree, fakeEnv([])))
    expect(result).toContainEqual(
      expect.objectContaining({ type: 'warn', message: 'kubeconfig /missing/kubeconfig does not exist' })
    )
  })
})

describe('checkIfContextExists', () => {
  function kubeconfigEnv(yaml: string): Environment {
    return {
      file: { read: vi.fn(async () => yaml) },
      status: { context: () => ({ write: vi.fn() }) },
    } as unknown as Environment
  }

  const service = { kubeconfig: '/kube/config', context: 'prod' } as KubernetesWorkService

  it('is true when the context is present', async () => {
    const env = kubeconfigEnv('contexts:\n  - name: prod\n  - name: dev\n')
    expect(await checkIfContextExists(service, env)).toBe(true)
  })

  it('is false when the context is absent', async () => {
    const env = kubeconfigEnv('contexts:\n  - name: dev\n')
    expect(await checkIfContextExists(service, env)).toBe(false)
  })

  it('is false when there are no contexts', async () => {
    const env = kubeconfigEnv('clusters:\n  - name: c1\n')
    expect(await checkIfContextExists(service, env)).toBe(false)
  })
})
