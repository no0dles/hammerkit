import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { WorkNodeValidation } from '../planner/work-node-validation'
import { WorkNode } from '../planner/work-node'
import { LogMode } from '../logging/log-mode'
import { CacheMethod } from '../parser/cache-method'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { createSchedulerState } from '../executer/create-scheduler-state'
import { isCI } from '../utils/ci'
import { getLogger } from './get-logger'
import { schedule } from '../executer/hierarchy-scheduler'
import { cleanCache, restoreCache, storeCache } from '../executer/event-cache'
import { validate } from '../planner/validate'
import { WorkTree } from '../planner/work-tree'
import { Environment } from '../executer/environment'
import { startWatchProcesses } from './start-watch-processes'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { ReadonlyState } from '../executer/readonly-state'
import { ProcessManager } from '../executer/process-manager'

export interface CliExecOptions {
  workers: number
  watch: boolean
  noContainer: boolean
  logMode: LogMode
  cacheDefault: CacheMethod
}

export interface CliExecResult {
  state: ReadonlyState<SchedulerState>
  start: () => Promise<SchedulerResult>
}

export interface Cli {
  exec(options?: Partial<CliExecOptions>): Promise<SchedulerResult>
  execWatch(options?: Partial<CliExecOptions>): CliExecResult

  store(path: string): Promise<void>

  restore(path: string): Promise<void>

  clean(): Promise<void>

  validate(): AsyncGenerator<WorkNodeValidation>

  ls(): WorkNode[]

  node(name: string): WorkNode
}

export function getCli(workTree: WorkTree, environment: Environment): Cli {
  return {
    execWatch(options?: Partial<CliExecOptions>): CliExecResult {
      const processManager = new ProcessManager(environment)
      const noContainer = options?.noContainer ?? false
      const state = createSchedulerState({
        services: workTree.services,
        nodes: workTree.nodes,
        watch: options?.watch ?? false,
        workers: options?.workers ?? 0,
        logMode: options?.logMode ?? isCI ? 'live' : 'interactive',
        noContainer,
        cacheMethod: options?.cacheDefault ?? 'checksum',
      })
      const logMode: LogMode = options?.logMode ?? (isCI ? 'live' : 'interactive')
      const logger = getLogger(logMode, state, environment)

      if (options?.watch) {
        startWatchProcesses(state, processManager, environment)
      }

      return {
        state,
        start: async () => {
          const result = await schedule(processManager, state, environment)
          await logger.complete(result, environment)
          return result
        },
      }
    },
    async exec(options?: Partial<CliExecOptions>): Promise<SchedulerResult> {
      return this.execWatch(options).start()
    },
    async clean(): Promise<void> {
      await cleanCache(workTree, environment)
    },
    async restore(path: string): Promise<void> {
      await restoreCache(path, workTree, environment)
    },
    async store(path: string): Promise<void> {
      await storeCache(path, workTree, environment)
    },
    ls(): WorkNode[] {
      return Array.from(iterateWorkNodes(workTree.nodes))
    },
    validate(): AsyncGenerator<WorkNodeValidation> {
      return validate(workTree, environment)
    },
    node(name: string): WorkNode {
      const node = Object.values(workTree.nodes).find((n) => n.name == name)
      if (!node) {
        throw new Error(`unable to find node ${name}`)
      }
      return node
    },
  }
}
