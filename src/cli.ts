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
import { ServiceState } from './executer/scheduler/service-state'
import { packageWorkTree } from './docker/package'
import { explainWorkTree, TaskExplanation } from './cache/explain'
import { GraphFormat, serializeWorkGraph, WorkGraphSerialization } from './planner/work-graph-serializer'
import { DryRunPlan, planDryRun } from './executer/dry-run'
import { CacheSyncOptions, CacheSyncResult, syncCache } from './cache/cache-sync'
import {
  autoPrune,
  listCache,
  NamedCacheEntry,
  pruneCache,
  PruneResult,
  retentionPolicyOf,
} from './cache/cache-inventory'
import { RetentionPolicy } from './cache/retention'

export type ExecuteKind = 'execute' | 'up' | 'down'
export interface CliExecOptions {
  type: ExecuteKind
  workers: number
  watch: boolean
  daemon: boolean
  logMode: LogMode
  cacheDefault: CacheMethod
  processManager: ProcessManager
  // When set, a task that executes due to a cache miss prints its miss cause
  // inline (reusing the cache-explain engine). Reporting only.
  explain: boolean
  // Restore from cache backends but never push to them — for untrusted runners
  // (e.g. agent sandboxes) that may read the shared cache but must not write it.
  cacheReadOnly: boolean
  // default maximum execution time in ms for tasks without their own timeout
  timeout: number | null
  // Skip dependencies that were not requested when every task needing them is
  // a cache hit (default). Off runs the whole dependency graph.
  skipDeps: boolean
  // `up --daemon` returns once services are healthy (ready) or once their
  // containers started (start); services others need are always awaited
  wait: 'ready' | 'start'
}

export interface CliPackageOptions {
  registry: string
  username: string | null
  password: string | null
  push: boolean
  overrideUser: boolean
  tag?: string
  platform?: string
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
            explain: options?.explain ?? false,
            cacheReadOnly: options?.cacheReadOnly ?? false,
            timeout: options?.timeout ?? null,
            skipDeps: options?.skipDeps ?? true,
            wait: options?.wait ?? 'ready',
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

  async clean(options?: { cache?: boolean }): Promise<void> {
    await cleanCache(this.workTree, this.environment, options)
  }

  async restore(path: string): Promise<void> {
    await restoreCache(this.environment, path, this.workTree)
  }

  async package(options: CliPackageOptions): Promise<void> {
    await packageWorkTree(this.workTree, this.environment, options)
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

  // Read-only cache prediction for every task in scope: executes no command,
  // starts no container/service, performs no cache push/pull.
  async explain(options?: { cacheDefault?: CacheMethod }): Promise<TaskExplanation[]> {
    return explainWorkTree(this.workTree, options?.cacheDefault ?? 'checksum', this.environment)
  }

  // Serialize the in-scope work graph for rendering (mermaid/dot). Pure read of
  // the planner's graph — nothing executes.
  graph(format: GraphFormat): WorkGraphSerialization {
    return serializeWorkGraph(this.workTree, format)
  }

  // Ordered execution plan with predicted cache decisions, reusing the explain
  // engine — executes nothing, starts nothing, performs no cache push/pull.
  async dryRun(options?: { cacheDefault?: CacheMethod }): Promise<DryRunPlan> {
    return planDryRun(this.workTree, options?.cacheDefault ?? 'checksum', this.environment)
  }

  // Move cache entries between the tasks' own caches and a named remote without
  // executing anything (`cache pull` / `cache push`).
  async syncCache(options: CacheSyncOptions): Promise<CacheSyncResult[]> {
    return syncCache(this.workTree, options, this.environment)
  }

  // Entries of a named cache (default: the local `default` cache).
  async listCache(cacheName?: string): Promise<NamedCacheEntry[]> {
    return listCache(this.workTree, cacheName, this.environment)
  }

  retentionPolicy(cacheName: string | undefined, overrides: RetentionPolicy): RetentionPolicy {
    return retentionPolicyOf(this.workTree, cacheName, overrides)
  }

  async pruneCache(cacheName: string | undefined, policy: RetentionPolicy, dryRun = false): Promise<PruneResult> {
    return pruneCache(this.workTree, cacheName, policy, { dryRun }, this.environment)
  }

  // Apply declared retention to the local caches this build file uses.
  async autoPrune(): Promise<{ cacheName: string; plan: PruneResult }[]> {
    return autoPrune(this.workTree, this.environment)
  }

  task(name: string): WorkItemState<WorkTask, TaskState> {
    const task = this.workTree.tasks[name]
    if (!task) {
      throw new Error(`unable to find task ${name}`)
    }
    return task
  }

  service(name: string): WorkItemState<WorkService, ServiceState> {
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
