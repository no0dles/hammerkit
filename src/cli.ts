import { SchedulerResult } from './executer/scheduler/scheduler-result'
import { WorkItemValidation } from './planner/work-item-validation'
import { WorkTask } from './planner/work-task'
import { LogMode } from './logging/log-mode'
import { CacheMethod } from './parser/cache-method'
import { hasError, iterateWorkTasks, iterateWorkServices } from './planner/utils/plan-work-tasks'
import { isCI } from './utils/ci'
import { getLogger } from './console/get-logger'
import { cleanCache, restoreCache, storeCache } from './executer/event-cache'
import { validate } from './planner/validate'
import { WorkTree } from './planner/work-tree'
import { Environment } from './executer/environment'
import { ProcessManager } from './executer/process-manager'
import { updateServiceStatus } from './service/update-service-status'
import { WorkItem, WorkItemState } from './planner/work-item'
import { WorkService } from './planner/work-service'
import { checkForLoop } from './executer/scheduler/check-for-loop'
import { State } from './executer/state'
import { getSchedulerExecuteResult } from './executer/get-scheduler-execute-result'
import { resetWorkTree } from './executer/reset-work-tree'
import { executeWorkTree } from './executer/execute-work-tree'
import { TaskState } from './executer/scheduler/task-state'

export type ExecuteKind = 'execute' | 'up' | 'down'
export interface CliExecOptions {
  type: ExecuteKind
  workers: number
  watch: boolean
  daemon: boolean
  logMode: LogMode
  cacheDefault: CacheMethod
  processManager: ProcessManager
}

export interface CliExecResult {
  state: State<WorkTree>
  start: () => Promise<SchedulerResult>
}

export interface CliTaskItem {
  type: 'task'
  item: WorkItem<WorkTask>
}

export interface CliServiceItem {
  type: 'service'
  item: WorkItem<WorkService>
}

export const isCliTask = (val: CliItem): val is CliTaskItem => val.type === 'task'
export const isCliService = (val: CliItem): val is CliServiceItem => val.type === 'service'
export type CliItem = CliTaskItem | CliServiceItem

export class Cli {
  constructor(
    private workTree: WorkTree,
    private environment: Environment
  ) {}

  setup(type: ExecuteKind, options?: Partial<CliExecOptions>): CliExecResult {
    const processManager = new ProcessManager(options?.workers ?? 0)
    const logMode: LogMode = options?.logMode ?? (isCI ? 'live' : 'interactive')

    const workTree = resetWorkTree(this.workTree, type)
    const processWorkTree = new State<WorkTree>(workTree, {
      subStates: [
        ...Object.values(workTree.services).map((s) => s.state),
        ...Object.values(workTree.tasks).map((s) => s.state),
      ],
    })

    const logger = getLogger(logMode, processWorkTree, this.environment)

    return {
      state: processWorkTree,
      start: async () => {
        checkForLoop(workTree)

        if (!hasError(workTree)) {
          await updateServiceStatus(workTree)

          await executeWorkTree(workTree, this.environment, {
            daemon: options?.daemon ?? false,
            watch: options?.watch ?? false,
            logMode,
            cacheDefault: options?.cacheDefault ?? 'checksum',
            workers: options?.workers ?? 0,
            processManager,
            type,
          })
        }

        const result = getSchedulerExecuteResult(workTree)
        await logger.complete(result, this.environment)

        return result
      },
    }
  }
  up(options?: Partial<CliExecOptions>): CliExecResult {
    return this.setup('up', options)
  }

  async runUp(options?: Partial<CliExecOptions>): Promise<SchedulerResult> {
    const run = this.up(options)
    return await run.start()
  }

  down(): CliExecResult {
    return this.setup('down', {})
  }

  async runDown(): Promise<SchedulerResult> {
    const run = await this.down()
    return await run.start()
  }

  exec(options?: Partial<CliExecOptions>): CliExecResult {
    return this.setup('execute', options)
  }

  async runExec(options?: Partial<CliExecOptions>): Promise<SchedulerResult> {
    const run = this.exec(options)
    return await run.start()
  }

  async clean(): Promise<void> {
    await cleanCache(this.workTree, this.environment)
  }

  async restore(path: string): Promise<void> {
    await restoreCache(this.environment, path, this.workTree)
  }

  async store(path: string): Promise<void> {
    await storeCache(this.environment, path, this.workTree)
  }

  services(): CliServiceItem[] {
    return Array.from(iterateWorkServices(this.workTree)).map<CliServiceItem>((item) => ({
      item,
      type: 'service',
    }))
  }

  tasks(): CliTaskItem[] {
    return Array.from(iterateWorkTasks(this.workTree)).map<CliTaskItem>((item) => ({ item, type: 'task' }))
  }

  ls(): CliItem[] {
    return [...this.services(), ...this.tasks()]
  }

  validate(): AsyncGenerator<WorkItemValidation> {
    return validate(this.workTree, this.environment)
  }

  task(name: string): WorkItemState<WorkTask, TaskState> {
    const task = this.workTree.tasks[name]
    if (!task) {
      throw new Error(`unable to find task ${name}`)
    }
    return task
  }

  service(name: string): WorkItem<WorkService> {
    const service = this.workTree.services[name]
    if (!service) {
      throw new Error(`unable to find service ${name}`)
    }
    return service
  }
}

export function getCli(workTree: WorkTree, environment: Environment): Cli {
  return new Cli(workTree, environment)
}
