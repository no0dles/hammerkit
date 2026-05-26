import { updateServiceStatus } from './update-service-status'
import { WorkTree } from '../planner/work-tree'

function fakeService(initialize: jest.Mock) {
  return {
    state: { current: { type: 'pending' } } as any,
    runtime: { initialize },
  } as any
}

describe('updateServiceStatus', () => {
  it('calls initialize(state) on every service runtime', async () => {
    const a = jest.fn().mockResolvedValue(undefined)
    const b = jest.fn().mockResolvedValue(undefined)
    const workTree: WorkTree = {
      services: { svcA: fakeService(a), svcB: fakeService(b) } as any,
      tasks: {},
    } as any
    await updateServiceStatus(workTree)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the work tree has no services', async () => {
    const workTree: WorkTree = { services: {}, tasks: {} } as any
    await expect(updateServiceStatus(workTree)).resolves.toBeUndefined()
  })
})
