import { SchedulerResult } from './executer/scheduler/scheduler-result'
import { WorkNodeValidation } from './planner/work-node-validation'
import { WorkNode } from './planner/work-node'
import { LogMode } from './logging/log-mode'
import { CacheMethod } from './parser/cache-method'
import { iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { createSchedulerState } from './executer/create-scheduler-state'
import { isCI } from './utils/ci'
import { getLogger } from './console/get-logger'
import { schedule } from './executer/hierarchy-scheduler'
import { cleanCache, restoreCache, storeCache } from './executer/event-cache'
import { validate } from './planner/validate'
import { WorkTree } from './planner/work-tree'
import { Environment } from './executer/environment'
import { startWatchProcesses } from './start-watch-processes'
import { SchedulerState } from './executer/scheduler/scheduler-state'
import { ReadonlyState } from './executer/readonly-state'
import { ProcessManager } from './executer/process-manager'
import { WorkService } from './planner/work-service'
import { getDocker } from './executer/execute-docker'
import { removeContainer } from './docker/remove-container'

export interface CliExecOptions {
  workers: number
  watch: boolean
  logMode: LogMode
  cacheDefault: CacheMethod
}

export interface CliCleanOptions {
  service: boolean
}

export interface CliExecResult {
  state: ReadonlyState<SchedulerState>
  start: () => Promise<SchedulerResult>
}

export interface CliTaskItem {
  type: 'task'
  item: WorkNode
}
export interface CliServiceItem {
  type: 'service'
  item: WorkService
}
export const isCliTask = (val: CliItem): val is CliTaskItem => val.type === 'task'
export const isCliService = (val: CliItem): val is CliServiceItem => val.type === 'service'
export type CliItem = CliTaskItem | CliServiceItem

export interface Cli {
  exec(options?: Partial<CliExecOptions>): Promise<SchedulerResult>
  execWatch(options?: Partial<CliExecOptions>): CliExecResult

  store(path: string): Promise<void>

  restore(path: string): Promise<void>

  clean(options?: Partial<CliCleanOptions>): Promise<void>

  validate(): AsyncGenerator<WorkNodeValidation>

  ls(): CliItem[]

  shutdown(): Promise<void>

  node(name: string): WorkNode
}

export function getCli(workTree: WorkTree, environment: Environment): Cli {
  return {
    execWatch(options?: Partial<CliExecOptions>): CliExecResult {
      const processManager = new ProcessManager(environment, options?.workers ?? 0)
      const state = createSchedulerState({
        services: workTree.services,
        nodes: workTree.nodes,
        watch: options?.watch ?? false,
        logMode: options?.logMode ?? isCI ? 'live' : 'interactive',
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
    async shutdown(): Promise<void> {
      for (const node of iterateWorkNodes(workTree.nodes)) {
        const status = environment.status.task(node)
        const docker = await getDocker(status)

        const containers = await docker.listContainers({
          all: true,
          filters: {
            label: [`hammerkit-id=${node.id}`],
          },
        })
        for (const container of containers) {
          await removeContainer(docker.getContainer(container.Id))
        }
      }

      for (const service of iterateWorkServices(workTree.services)) {
        const status = environment.status.service(service)
        const docker = await getDocker(status)

        const containers = await docker.listContainers({
          all: true,
          filters: {
            label: [`hammerkit-id=${service.id}`],
          },
        })
        for (const container of containers) {
          await removeContainer(docker.getContainer(container.Id))
        }
      }
    },
    async exec(options?: Partial<CliExecOptions>): Promise<SchedulerResult> {
      return this.execWatch(options).start()
    },
    async clean(options?: Partial<CliCleanOptions>): Promise<void> {
      await cleanCache(workTree, environment, {
        service: options?.service ?? false,
      })
    },
    async restore(path: string): Promise<void> {
      await restoreCache(path, workTree, environment)
    },
    async store(path: string): Promise<void> {
      await storeCache(path, workTree, environment)
    },
    ls(): CliItem[] {
      return [
        ...Array.from(iterateWorkServices(workTree.services)).map<CliItem>((item) => ({ item, type: 'service' })),
        ...Array.from(iterateWorkNodes(workTree.nodes)).map<CliItem>((item) => ({ item, type: 'task' })),
      ]
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
