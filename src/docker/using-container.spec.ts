import type { Mock } from 'vitest'
import { usingContainer } from './using-container'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'

interface FakeContainer {
  id: string
  start: Mock
  pause: Mock
  remove: Mock
}

function makeContainer(id: string): FakeContainer {
  return {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  }
}

interface FakeDocker {
  createContainer: Mock
  listContainers: Mock
  getContainer: Mock
}

function makeDocker(newContainer: FakeContainer, listed: { Id: string; State: string }[] = []) {
  const containersById: Record<string, FakeContainer> = { [newContainer.id]: newContainer }
  for (const entry of listed) {
    containersById[entry.Id] = makeContainer(entry.Id)
  }
  return {
    docker: {
      createContainer: vi.fn().mockResolvedValue(newContainer),
      listContainers: vi.fn().mockResolvedValue(listed),
      getContainer: vi.fn((id: string) => containersById[id] ?? makeContainer(id)),
    } as FakeDocker,
    containersById,
  }
}

function makeItem(id: string): WorkItem<ContainerWorkTask> {
  return {
    id: () => id,
    name: id,
    status: { write: vi.fn() } as any,
    data: { type: 'container-task', image: 'alpine' } as any,
    needs: [],
    deps: [],
    requiredBy: [],
  }
}

describe('usingContainer', () => {
  it('removes the container when the callback succeeds, without pausing it', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)

    await usingContainer(docker as any, makeItem('task-1'), {}, async () => true)

    expect(created.pause).not.toHaveBeenCalled()
    expect(created.remove).toHaveBeenCalledTimes(1)
  })

  it('removes the container when the callback returns false', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)

    await usingContainer(docker as any, makeItem('task-1'), {}, async () => false)

    expect(created.remove).toHaveBeenCalledTimes(1)
  })

  it('removes the container when the callback throws', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)

    await expect(
      usingContainer(docker as any, makeItem('task-1'), {}, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(created.remove).toHaveBeenCalledTimes(1)
  })

  it('removes paused and exited leftovers of the item but keeps a running one', async () => {
    const created = makeContainer('new-cid')
    const { docker, containersById } = makeDocker(created, [
      { Id: 'paused-cid', State: 'paused' },
      { Id: 'exited-cid', State: 'exited' },
      { Id: 'running-cid', State: 'running' },
    ])

    await usingContainer(docker as any, makeItem('task-1'), {}, async () => true)

    expect(containersById['paused-cid'].remove).toHaveBeenCalledTimes(1)
    expect(containersById['exited-cid'].remove).toHaveBeenCalledTimes(1)
    expect(containersById['running-cid'].remove).not.toHaveBeenCalled()
  })

  it('propagates the callback return value', async () => {
    const created = makeContainer('new-cid')
    const { docker } = makeDocker(created)

    const result = await usingContainer(docker as any, makeItem('task-1'), {}, async () => 'payload')

    expect(result).toBe('payload')
  })
})
