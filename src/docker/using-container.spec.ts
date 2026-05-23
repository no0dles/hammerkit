import { usingContainer } from './using-container'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'

interface FakeContainer {
  id: string
  start: jest.Mock
  pause: jest.Mock
  remove: jest.Mock
}

function makeContainer(id: string): FakeContainer {
  return {
    id,
    start: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  }
}

interface FakeDocker {
  createContainer: jest.Mock
  listContainers: jest.Mock
  getContainer: jest.Mock
}

function makeDocker(newContainer: FakeContainer, listed: { Id: string; Labels: Record<string, string> }[] = []) {
  const containersById: Record<string, FakeContainer> = { [newContainer.id]: newContainer }
  for (const entry of listed) {
    containersById[entry.Id] = makeContainer(entry.Id)
  }
  return {
    docker: {
      createContainer: jest.fn().mockResolvedValue(newContainer),
      listContainers: jest.fn().mockResolvedValue(listed),
      getContainer: jest.fn((id: string) => containersById[id] ?? makeContainer(id)),
    } as FakeDocker,
    containersById,
  }
}

function makeItem(id: string): WorkItem<ContainerWorkTask> {
  return {
    id: () => id,
    name: id,
    status: { write: jest.fn() } as any,
    data: { type: 'container-task', image: 'alpine' } as any,
    needs: [],
    deps: [],
    requiredBy: [],
  }
}

describe('usingContainer', () => {
  it('pauses the container on success when stateKey is set', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)
    const item = makeItem('task-1')

    await usingContainer(docker as any, item, {}, 'state-A', async () => true)

    expect(created.pause).toHaveBeenCalledTimes(1)
    expect(created.remove).not.toHaveBeenCalled()
  })

  it('removes containers with a different stateKey and keeps the current one', async () => {
    const created = makeContainer('new-cid')
    const stale = { Id: 'old-cid', Labels: { 'hammerkit-state': 'state-B' } }
    const same = { Id: 'new-cid', Labels: { 'hammerkit-state': 'state-A' } }
    const { docker, containersById } = makeDocker(created, [stale, same])
    const item = makeItem('task-1')

    await usingContainer(docker as any, item, {}, 'state-A', async () => true)

    expect(containersById['old-cid'].remove).toHaveBeenCalledTimes(1)
    expect(created.remove).not.toHaveBeenCalled()
  })

  it('removes the container when the callback returns false (cache miss on failure)', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)
    const item = makeItem('task-1')

    await usingContainer(docker as any, item, {}, 'state-A', async () => false)

    expect(created.pause).not.toHaveBeenCalled()
    expect(created.remove).toHaveBeenCalledTimes(1)
  })

  it('removes the container when the callback throws', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)
    const item = makeItem('task-1')

    await expect(
      usingContainer(docker as any, item, {}, 'state-A', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(created.pause).not.toHaveBeenCalled()
    expect(created.remove).toHaveBeenCalledTimes(1)
  })

  it('always removes the container when no stateKey is given', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)
    const item = makeItem('task-1')

    await usingContainer(docker as any, item, {}, null, async () => true)

    expect(created.pause).not.toHaveBeenCalled()
    expect(created.remove).toHaveBeenCalledTimes(1)
  })

  it('propagates the callback return value', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)
    const item = makeItem('task-1')

    const result = await usingContainer(docker as any, item, {}, null, async () => 'payload')

    expect(result).toBe('payload')
  })
})
