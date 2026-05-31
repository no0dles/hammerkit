import { Writable } from 'stream'
import { State } from '../executer/state'
import { WorkTree } from '../planner/work-tree'
import { TaskState } from '../executer/scheduler/task-state'
import { ServiceState } from '../executer/scheduler/service-state'
import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkService } from '../planner/work-service'
import { statusConsole } from '../planner/work-item-status'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'

import { liveLogger } from './live-logger'
import { groupedLogger } from './grouped-logger'
import { interactiveLogger } from './interactive-logger'

function memStream(): Writable & { read(): string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(c, _e, cb) {
      chunks.push(c.toString())
      cb()
    },
  })
  return Object.assign(stream, { read: () => chunks.join('') })
}

function noopStream(): Writable {
  return new Writable({ write: (_c, _e, cb) => cb() })
}

function makeEnv(stdout: Writable = noopStream()): Environment {
  return {
    cwd: '/tmp',
    file: {} as any,
    processEnvs: {},
    abortCtrl: new AbortController(),
    console: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), log: vi.fn() } as any,
    status: statusConsole(noopStream()),
    stdout,
    stderr: noopStream(),
    stdoutColumns: 80,
  } as Environment
}

function taskItem(env: Environment, name: string, state: TaskState): WorkItemState<WorkTask, TaskState> {
  const data = { type: 'local-task', name, description: null, scope: { fileName: 'x' } } as unknown as WorkTask
  return {
    id: () => name,
    name,
    data,
    status: env.status.from(data),
    state: new State<TaskState>(state),
    needs: [],
    deps: [],
    requiredBy: [],
    runtime: {} as any,
  }
}

function serviceItem(env: Environment, name: string, state: ServiceState): WorkItemState<WorkService, ServiceState> {
  const data = { type: 'container-service', name, ports: [] } as unknown as WorkService
  return {
    id: () => name,
    name,
    data,
    status: env.status.from(data),
    state: new State<ServiceState>(state),
    needs: [],
    deps: [],
    requiredBy: [],
    runtime: {} as any,
  }
}

function workTree(items: {
  tasks?: WorkItemState<WorkTask, TaskState>[]
  services?: WorkItemState<WorkService, ServiceState>[]
}): WorkTree {
  return {
    tasks: Object.fromEntries((items.tasks ?? []).map((t) => [t.name, t])),
    services: Object.fromEntries((items.services ?? []).map((s) => [s.name, s])),
    environment: { type: 'docker' } as any,
  }
}

describe('loggers', () => {
  describe('liveLogger', () => {
    it('writes each status message and renders results on complete', async () => {
      const out = memStream()
      const env = makeEnv(out)
      const task = taskItem(env, 'build', { type: 'pending', stateKey: null } as TaskState)
      const tree = workTree({ tasks: [task] })
      const state = new State<WorkTree>(tree)

      const logger = liveLogger(state, env)

      // a write on the scoped console emits a message on env.status, which the
      // logger's listener formats into env.stdout
      task.status.write('info', 'compiling')

      const result: SchedulerResult = { state: tree, success: true }
      await logger.complete(result, env)

      expect(out.read()).toContain('compiling')
    })
  })

  describe('groupedLogger', () => {
    it("writes a completed task's logs on the next status update", async () => {
      const out = memStream()
      const env = makeEnv(out)
      const task = taskItem(env, 'build', { type: 'pending', stateKey: null } as TaskState)
      const tree = workTree({ tasks: [task] })
      const state = new State<WorkTree>(tree)

      const logger = groupedLogger(state, env)

      // buffer one info log, mark the task completed, then notify the parent state
      task.status.write('info', 'compiling')
      task.state.set({ type: 'completed', stateKey: 'k', duration: 5, cached: false } as TaskState)
      state.set(tree)

      await logger.complete({ state: tree, success: true }, env)
      expect(out.read()).toContain('compiling')
    })

    it("writes an ended service's logs on the next status update", async () => {
      const out = memStream()
      const env = makeEnv(out)
      const svc = serviceItem(env, 'db', { type: 'pending', stateKey: null } as ServiceState)
      const tree = workTree({ services: [svc] })
      const state = new State<WorkTree>(tree)

      const logger = groupedLogger(state, env)

      svc.status.write('info', 'ready')
      svc.state.set({ type: 'end', reason: 'terminated', stateKey: 'k' } as ServiceState)
      state.set(tree)

      await logger.complete({ state: tree, success: true }, env)
      expect(out.read()).toContain('ready')
    })

    it('does not duplicate a task that is already in the completed set', async () => {
      const out = memStream()
      const env = makeEnv(out)
      const task = taskItem(env, 'build', { type: 'pending', stateKey: null } as TaskState)
      const tree = workTree({ tasks: [task] })
      const state = new State<WorkTree>(tree)
      const logger = groupedLogger(state, env)

      task.status.write('info', 'once')
      task.state.set({ type: 'completed', stateKey: 'k', duration: 1, cached: false } as TaskState)
      state.set(tree)
      const after = out.read()
      // a second notification with no further log message should not append another copy
      state.set(tree)
      expect(out.read()).toEqual(after)
      await logger.complete({ state: tree, success: true }, env)
    })
  })

  describe('interactiveLogger', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('hides the cursor, ticks, redraws on log-status, then cleans up on complete', async () => {
      const out = memStream()
      const env = makeEnv(out)
      const task = taskItem(env, 'build', { type: 'pending', stateKey: null } as TaskState)
      const tree = workTree({ tasks: [task] })
      const state = new State<WorkTree>(tree)

      const logger = interactiveLogger(state, env) // hideCursor + first tick + setTimeout

      // drive a state change to re-render
      task.state.set({ type: 'running', stateKey: 'k' } as TaskState)
      state.set(tree)

      // let one fake tick fire while running===true (covers the recursive branch)
      vi.advanceTimersByTime(150)

      await logger.complete({ state: tree, success: true }, env)

      // and one more after complete — covers the `if (!running) return` early exit
      vi.advanceTimersByTime(150)

      expect(out.read().length).toBeGreaterThan(0)
    })
  })
})
