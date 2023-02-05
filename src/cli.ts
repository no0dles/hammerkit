import { SchedulerResult } from './executer/scheduler/scheduler-result'
import { WorkNodeValidation } from './planner/work-node-validation'
import { WorkNode } from './planner/work-node'
import { LogMode } from './logging/log-mode'
import { CacheMethod } from './parser/cache-method'
import { iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { createSchedulerState } from './executer/create-scheduler-state'
import { isCI } from './utils/ci'
import { getLogger } from './console/get-logger'
import { scheduleExecution } from './executer/schedule-execution'
import { cleanCache, restoreCache, storeCache } from './executer/event-cache'
import { validate } from './planner/validate'
import { WorkTree } from './planner/work-tree'
import { Environment } from './executer/environment'
import { SchedulerState } from './executer/scheduler/scheduler-state'
import { ReadonlyState } from './executer/readonly-state'
import { ProcessManager } from './executer/process-manager'
import { removeContainer } from './docker/remove-container'
import { updateServiceStatus } from './service/update-service-status'
import { scheduleUp } from './executer/schedule-up'
import { scheduleDown } from './executer/schedule-down'
import { State } from './executer/state'
import { deployKubernetes } from './executer/kubernetes/schedule-kubernetes'
import { WorkItem } from './planner/work-item'
import { WorkService } from './planner/work-service'

export interface CliExecOptions {
  workers: number
  watch: boolean
  daemon: boolean
  logMode: LogMode
  cacheDefault: CacheMethod
}

export interface CliDeployOptions {}

export interface CliCleanOptions {
  service: boolean
}

export interface CliExecResult {
  state: ReadonlyState<SchedulerState>
  processManager: ProcessManager
  start: () => Promise<SchedulerResult>
}

export interface CliTaskItem {
  type: 'task'
  item: WorkItem<WorkNode>
}

export interface CliServiceItem {
  type: 'service'
  item: WorkItem<WorkService>
}

export const isCliTask = (val: CliItem): val is CliTaskItem => val.type === 'task'
export const isCliService = (val: CliItem): val is CliServiceItem => val.type === 'service'
export type CliItem = CliTaskItem | CliServiceItem

export class Cli {
  constructor(private workTree: WorkTree, private environment: Environment) {}

  async setup(
    scheduler: (process: ProcessManager, state: State, environment: Environment) => Promise<SchedulerResult>,
    workTreeSelector: (workTree: WorkTree) => WorkTree,
    options?: Partial<CliExecOptions>
  ): Promise<CliExecResult> {
    const processManager = new ProcessManager(this.environment, options?.workers ?? 0)
    const logMode: LogMode = options?.logMode ?? (isCI ? 'live' : 'interactive')
    const processWorkTree = workTreeSelector(this.workTree)
    const state = createSchedulerState({
      daemon: options?.daemon ?? false,
      services: processWorkTree.services,
      nodes: processWorkTree.nodes,
      watch: options?.watch ?? false,
      logMode,
      cacheMethod: options?.cacheDefault ?? 'checksum',
    })

    await updateServiceStatus(state, this.environment)

    const logger = getLogger(logMode, state, this.environment)

    return {
      state,
      processManager,
      start: async () => {
        const result = await scheduler(processManager, state, this.environment)
        await logger.complete(result, this.environment)
        return result
      },
    }
  }

  async shutdown(): Promise<void> {
    for (const node of iterateWorkNodes(this.workTree.nodes)) {
      const containers = await this.environment.docker.listContainers({
        all: true,
        filters: {
          label: [`hammerkit-id=${node.id}`],
        },
      })
      for (const container of containers) {
        await removeContainer(this.environment.docker.getContainer(container.Id))
      }
    }

    for (const service of iterateWorkServices(this.workTree.services)) {
      const containers = await this.environment.docker.listContainers({
        all: true,
        filters: {
          label: [`hammerkit-id=${service.id}`],
        },
      })
      for (const container of containers) {
        await removeContainer(this.environment.docker.getContainer(container.Id))
      }
    }
  }

  async up(options?: Partial<CliExecOptions>): Promise<CliExecResult> {
    return await this.setup(scheduleUp, (workTree) => workTree, options)
  }

  async deploy(envName: string, options?: Partial<CliDeployOptions>) {
    const env = this.workTree.environments[envName]
    return await deployKubernetes(this.workTree, env, options)
  }

  async runUp(options?: Partial<CliExecOptions>): Promise<SchedulerResult> {
    const run = await this.up(options)
    return await run.start()
  }

  async down(): Promise<CliExecResult> {
    return await this.setup(
      scheduleDown,
      (workTree) => ({ services: workTree.services, nodes: {}, environments: {} }),
      {}
    )
  }

  async runDown(): Promise<SchedulerResult> {
    const run = await this.down()
    return await run.start()
  }

  async exec(options?: Partial<CliExecOptions>): Promise<CliExecResult> {
    return await this.setup(scheduleExecution, (workTree) => workTree, options)
  }

  async runExec(options?: Partial<CliExecOptions>): Promise<SchedulerResult> {
    const run = await this.exec(options)
    return await run.start()
  }

  async clean(options?: Partial<CliCleanOptions>): Promise<void> {
    await cleanCache(this.workTree, this.environment, {
      service: options?.service ?? false,
    })
  }

  async restore(path: string): Promise<void> {
    await restoreCache(path, this.workTree, this.environment)
  }

  async store(path: string): Promise<void> {
    await storeCache(path, this.workTree, this.environment)
  }

  ls(): CliItem[] {
    return [
      ...Array.from(iterateWorkServices(this.workTree.services)).map<CliItem>((item) => ({ item, type: 'service' })),
      ...Array.from(iterateWorkNodes(this.workTree.nodes)).map<CliItem>((item) => ({ item, type: 'task' })),
    ]
  }

  validate(): AsyncGenerator<WorkNodeValidation> {
    return validate(this.workTree, this.environment)
  }

  node(name: string): WorkItem<WorkNode> {
    const node = Object.values(this.workTree.nodes).find((n) => n.name == name)
    if (!node) {
      throw new Error(`unable to find node ${name}`)
    }
    return node
  }
}

export function getCli(workTree: WorkTree, environment: Environment): Cli {
  return new Cli(workTree, environment)
}
