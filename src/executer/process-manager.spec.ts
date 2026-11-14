import { ProcessManager } from './process-manager'
import { WorkItem } from '../planner/work-item'
import { logContext, statusConsole } from '../planner/work-item-status'
import { emptyWritable } from '../utils/empty-writable'

describe('process-manager', () => {
  function fakeWorkItem(id: string) {
    return {
      id: () => '',
      status: statusConsole(emptyWritable()).context(logContext('task', { name: id } as any)),
      deps: [],
      aliases: [id],
      needs: [],
      requiredBy: [],
      name: id,
      data: null,
      state: null,
      runtime: null as any,
    } as WorkItem<any>
  }

  it('should complete on success', async () => {
    const manager = new ProcessManager(0)

    let called = false
    await manager.task(
      fakeWorkItem('a'),
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            called = true
            resolve()
          }, 100)
        )
    )
    expect(called).toBeTruthy()
  })

  it('should throw error', async () => {
    const manager = new ProcessManager(0)

    await expect(
      manager.task(
        fakeWorkItem('a'),
        () => new Promise<void>((resolve, reject) => setTimeout(() => reject(new Error('3')), 100))
      )
    ).rejects.toThrow('3')
  })

  it('should not start more than worker count', async () => {
    const manager = new ProcessManager(1)

    let concurrencyCount = 0

    const fakeAction = () =>
      new Promise<void>((resolve) => {
        expect(concurrencyCount).toBe(0)
        concurrencyCount++
        setTimeout(() => {
          expect(concurrencyCount).toBe(1)
          concurrencyCount--
          resolve()
        }, 100)
      })

    await Promise.all([
      manager.task(fakeWorkItem('a'), fakeAction),
      manager.task(fakeWorkItem('b'), fakeAction),
      manager.task(fakeWorkItem('c'), fakeAction),
    ])

    expect(concurrencyCount).toBe(0)
  })

  describe('with a priority', () => {
    function gate() {
      let open!: () => void
      const promise = new Promise<void>((resolve) => (open = resolve))
      return { promise, open }
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

    it('gives a free place to the most urgent of the tasks that arrived together', async () => {
      const ranks: Record<string, number> = { short: 1, long: 10, middle: 5 }
      const manager = new ProcessManager(1, null, (item) => ranks[item.name])
      const started: string[] = []
      const runs = ['short', 'long', 'middle'].map((name) =>
        manager.task(fakeWorkItem(name), async () => {
          started.push(name)
        })
      )
      await Promise.all(runs)
      expect(started).toEqual(['long', 'middle', 'short'])
    })

    it('keeps the order of arrival among tasks equally urgent', async () => {
      const manager = new ProcessManager(1, null, () => 1)
      const started: string[] = []
      await Promise.all(
        ['a', 'b', 'c'].map((name) =>
          manager.task(fakeWorkItem(name), async () => {
            started.push(name)
          })
        )
      )
      expect(started).toEqual(['a', 'b', 'c'])
    })

    it('holds back the tasks less urgent than one whose pod the quota refuses', async () => {
      const ranks: Record<string, number> = { refused: 5, urgent: 8, later: 2 }
      const manager = new ProcessManager(0, null, (item) => ranks[item.name])
      const refused = fakeWorkItem('refused')
      const started: string[] = []
      const running = gate()
      const first = manager.task(refused, async () => {
        started.push('refused')
        await running.promise
      })
      await tick()
      manager.quotaRefused(refused, true)
      const others = ['later', 'urgent'].map((name) =>
        manager.task(fakeWorkItem(name), async () => {
          started.push(name)
        })
      )
      await tick()
      // urgent is more urgent than the refused task, later waits for it
      expect(started).toEqual(['refused', 'urgent'])
      manager.quotaRefused(refused, false)
      await tick()
      expect(started).toEqual(['refused', 'urgent', 'later'])
      running.open()
      await Promise.all([first, ...others])
    })

    it('never holds back a task that needs a service, whose room it frees once it ran', async () => {
      const ranks: Record<string, number> = { refused: 5, later: 2, withService: 1 }
      const manager = new ProcessManager(0, null, (item) => ranks[item.name])
      const refused = fakeWorkItem('refused')
      const withService = { ...fakeWorkItem('withService'), needs: [{ name: 'db', service: {} as any }] }
      const started: string[] = []
      const running = gate()
      const first = manager.task(refused, async () => {
        manager.quotaRefused(refused, true)
        await running.promise
      })
      await tick()
      const others = [fakeWorkItem('later'), withService].map((item) =>
        manager.task(item, async () => {
          started.push(item.name)
        })
      )
      await tick()
      expect(started).toEqual(['withService'])
      running.open()
      await Promise.all([first, ...others])
      expect(started).toEqual(['withService', 'later'])
    })

    it('lets the held back tasks go once the refused task ends', async () => {
      const ranks: Record<string, number> = { refused: 5, later: 2 }
      const manager = new ProcessManager(0, null, (item) => ranks[item.name])
      const refused = fakeWorkItem('refused')
      const started: string[] = []
      const running = gate()
      const first = manager.task(refused, async () => {
        manager.quotaRefused(refused, true)
        await running.promise
      })
      await tick()
      const later = manager.task(fakeWorkItem('later'), async () => {
        started.push('later')
      })
      await tick()
      expect(started).toEqual([])
      // it failed while refused, it never says it is not refused anymore
      running.open()
      await Promise.all([first, later])
      expect(started).toEqual(['later'])
    })
  })
})
