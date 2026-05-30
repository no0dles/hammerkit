import { hasError, hasErrorService, hasErrorTask, iterateWorkServices, iterateWorkTasks } from './plan-work-tasks'
import { WorkTree } from '../work-tree'

const ok = { state: { current: { type: 'completed' } } } as any
const err = { state: { current: { type: 'error' } } } as any
const tree = (services: Record<string, any>, tasks: Record<string, any>): WorkTree => ({ services, tasks }) as any

describe('plan-work-tasks iterators and error helpers', () => {
  it('iterateWorkServices yields every service value', () => {
    const t = tree({ a: { id: 'A' }, b: { id: 'B' } }, {})
    expect([...iterateWorkServices(t)].map((s) => (s as any).id)).toEqual(['A', 'B'])
  })

  it('iterateWorkTasks yields every task value', () => {
    const t = tree({}, { a: { id: 'A' } })
    expect([...iterateWorkTasks(t)].map((s) => (s as any).id)).toEqual(['A'])
  })

  it('hasErrorTask is true iff a task is in error', () => {
    expect(hasErrorTask(tree({}, { a: ok }))).toBe(false)
    expect(hasErrorTask(tree({}, { a: ok, b: err }))).toBe(true)
  })

  it('hasErrorService is true iff a service is in error', () => {
    expect(hasErrorService(tree({ a: ok }, {}))).toBe(false)
    expect(hasErrorService(tree({ a: err }, {}))).toBe(true)
  })

  it('hasError covers both services and tasks', () => {
    expect(hasError(tree({}, {}))).toBe(false)
    expect(hasError(tree({ a: err }, {}))).toBe(true)
    expect(hasError(tree({}, { a: err }))).toBe(true)
  })
})
