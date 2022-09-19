import { EventBus } from './event-bus'
import { SchedulerStartContainerNodeEvent, SchedulerStartLocalNodeEvent, SchedulerStartServiceEvent } from './events'
import { ExecutionMock, ExecutionMockNode, MockNodeState } from '../testing/test-suite'
import { WorkNodes } from '../planner/work-nodes'
import { getNode } from '../testing/get-node'
import { BuildFile } from '../parser/build-file'
import { WorkNode } from '../planner/work-node'

export function attachExecutionMock(eventBus: EventBus, buildFile: BuildFile, nodes: WorkNodes): ExecutionMock {
  const mockNodes: { [key: string]: MockNode } = {}
  const mock: ExecutionMock = {
    getNode(name: string): ExecutionMockNode {
      const node = getNode(buildFile, nodes, name)
      return getMockNode(node)
    },
    clearNode(name: string): void {
      delete mockNodes[name]
    },
  }

  function getMockNode(node: WorkNode) {
    if (!mockNodes[node.id]) {
      mockNodes[node.id] = new MockNode(node)
    }
    return mockNodes[node.id]
  }

  eventBus.on<SchedulerStartContainerNodeEvent>('scheduler-start-container-node', async (evt) => {
    const node = getMockNode(evt.node)
    const result = await node.run()

    if (result.exitCode !== 0) {
      await eventBus.emit({
        type: 'node-crash',
        node: evt.node,
        command: 'mock',
        exitCode: result.exitCode ?? 1,
      })
    } else {
      await eventBus.emit({
        type: 'node-completed',
        node: evt.node,
      })
    }
  })

  eventBus.on<SchedulerStartServiceEvent>('scheduler-start-service', async (evt) => {
    await eventBus.emit({
      type: 'service-ready',
      service: evt.service,
      containerId: 'mock',
    })
  })

  eventBus.on<SchedulerStartLocalNodeEvent>('scheduler-start-local-node', async (evt) => {
    const node = getMockNode(evt.node)
    const result = await node.run()

    if (result.exitCode !== 0) {
      await eventBus.emit({
        type: 'node-crash',
        node: evt.node,
        command: 'mock',
        exitCode: result.exitCode ?? 1,
      })
    } else {
      await eventBus.emit({
        type: 'node-completed',
        node: evt.node,
      })
    }
  })

  return mock
}

class MockNode implements ExecutionMockNode {
  private durationInMs = 0
  private executionTimer: NodeJS.Timer | null = null
  private exitCode = 0
  private executeCounter = 0
  private state: MockNodeState = 'pending'
  private resolveFn: ((result: { exitCode: number }) => void) | null = null
  private listeners: { [key: string]: (() => void)[] } = {}

  constructor(private node: WorkNode) {}

  get executeCount() {
    return this.executeCounter
  }

  end(exitCode: number): void {
    this.exitCode = exitCode
  }

  getState(): MockNodeState {
    return this.state
  }

  setDuration(durationInMs: number): void {
    this.durationInMs = durationInMs

    const runTimer = () => {
      this.executionTimer = setTimeout(() => {
        if (this.resolveFn) {
          this.resolveFn({ exitCode: this.exitCode })
        }
        this.state = 'ended'
        this.runStateListeners()
      }, durationInMs)
    }
    if (this.state === 'running') {
      runTimer()
    } else if (this.state === 'pending') {
      this.onState('running', () => {
        runTimer()
      })
    }
  }

  onState(state: MockNodeState, callback: () => void) {
    if (!this.listeners[state]) {
      this.listeners[state] = []
    }
    this.listeners[state].push(callback)
  }

  waitFor(state: MockNodeState): Promise<void> {
    return new Promise<void>((resolve) => {
      this.onState(state, resolve)
    })
  }

  run(): Promise<{ exitCode: number }> {
    this.state = 'running'
    this.executeCounter++
    return new Promise<{ exitCode: number }>((resolve) => {
      this.resolveFn = resolve
      this.runStateListeners()
    })
  }

  private runStateListeners() {
    for (const listener of this.listeners[this.state] || []) {
      listener()
    }
  }
}
