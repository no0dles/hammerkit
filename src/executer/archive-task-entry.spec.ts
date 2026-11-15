import { archiveTaskEntry } from './archive-task-entry'
import { State } from './state'
import { TaskState } from './scheduler/task-state'

vi.mock('../optimizer/get-work-cache-stats', () => ({
  getWorkItemCacheStats: async () => ({ stats: {} }),
}))
vi.mock('./cache-metadata', () => ({ writeCacheMetadata: async () => undefined }))
vi.mock('../optimizer/work-task-cache-description', () => ({ getWorkTaskCacheDescription: () => ({}) }))
vi.mock('../planner/work-instance-id', () => ({ getWorkInstanceId: () => 'build-1' }))

// The work item a runtime is made with has no state (see appendWorkTask): a runtime
// whose outputs are by state (a service run on Kubernetes) is told which state it archives.
describe('archiveTaskEntry', () => {
  function task(current: TaskState) {
    const archive = vi.fn(async () => undefined)
    return {
      archive,
      work: { id: () => 'build', name: 'build', state: new State<TaskState>(current), runtime: { archive } } as any,
    }
  }

  it('archives the outputs of the state the task ran at', async () => {
    const { archive, work } = task({ type: 'running', started: new Date(), stateKey: 'key-2' })
    await archiveTaskEntry(work, {} as any)
    expect(archive).toHaveBeenCalledWith({}, expect.any(String), 'key-2')
  })

  it('archives the outputs of the state it is asked for', async () => {
    const { archive, work } = task({ type: 'pending', stateKey: null })
    await archiveTaskEntry(work, {} as any, 'key-3')
    expect(archive).toHaveBeenCalledWith({}, expect.any(String), 'key-3')
  })
})
