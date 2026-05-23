import { hasDependencyCycle, hasNeedCycle } from './validate'
import { WorkItemNeed, WorkItemState } from './work-item'
import { WorkService } from './work-service'
import { WorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { ServiceState } from '../executer/scheduler/service-state'

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
})
