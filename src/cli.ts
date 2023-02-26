import { SchedulerResult } from './executer/scheduler/scheduler-result'
import { WorkNodeValidation } from './planner/work-node-validation'
import { WorkNode } from './planner/work-node'
import { LogMode } from './logging/log-mode'
import { CacheMethod } from './parser/cache-method'
import { hasError, iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { isCI } from './utils/ci'
import { getLogger } from './console/get-logger'
import { cleanCache, restoreCache, storeCache } from './executer/event-cache'
import { validate } from './planner/validate'
import { WorkTree } from './planner/work-tree'
import { Environment } from './executer/environment'
import { ProcessManager } from './executer/process-manager'
import { removeContainer } from './docker/remove-container'
import { updateServiceStatus } from './service/update-service-status'
import { WorkItem } from './planner/work-item'
import { WorkService } from './planner/work-service'
import { deployKubernetes } from './kubernetes/schedule-kubernetes'
import { createKubernetesInstances } from './kubernetes/kubernetes-instance'
import { checkForLoop } from './executer/scheduler/check-for-loop'
import { State } from './executer/state'
import { getSchedulerExecuteResult } from './executer/get-scheduler-execute-result'
import { resetWorkTree } from './executer/reset-work-tree'
import { executeWorkTree } from './executer/execute-work-tree'

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

export interface CliCleanOptions {
  service: boolean
}

export interface CliExecResult {
  state: State<WorkTree>
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

  setup(type: ExecuteKind, options?: Partial<CliExecOptions>): CliExecResult {
    const processManager = new ProcessManager(options?.workers ?? 0)
    const logMode: LogMode = options?.logMode ?? (isCI ? 'live' : 'interactive')

    const workTree = resetWorkTree(this.workTree)
    const processWorkTree = new State<WorkTree>(workTree, () => {}, [
      ...Object.values(workTree.services).map((s) => s.state),
      ...Object.values(workTree.nodes).map((s) => s.state),
    ])

    const logger = getLogger(logMode, processWorkTree, this.environment)

    return {
      state: processWorkTree,
      start: async () => {
        checkForLoop(workTree)

        if (!hasError(workTree)) {
          await updateServiceStatus(workTree, this.environment)

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

  async shutdown(): Promise<void> {
    for (const node of iterateWorkNodes(this.workTree)) {
      const containers = await this.environment.docker.listContainers({
        all: true,
        filters: {
          label: [`hammerkit-id=${node.id()}`],
        },
      })
      for (const container of containers) {
        await removeContainer(this.environment.docker.getContainer(container.Id))
      }
    }

    for (const service of iterateWorkServices(this.workTree)) {
      const containers = await this.environment.docker.listContainers({
        all: true,
        filters: {
          label: [`hammerkit-id=${service.id()}`],
        },
      })
      for (const container of containers) {
        await removeContainer(this.environment.docker.getContainer(container.Id))
      }
    }
  }

  up(options?: Partial<CliExecOptions>): CliExecResult {
    return this.setup('up', options)
  }

  async deploy(envName: string) {
    const env = this.workTree.environments[envName]
    return await deployKubernetes(createKubernetesInstances(), this.workTree, env)
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

  services(): CliServiceItem[] {
    return Array.from(iterateWorkServices(this.workTree)).map<CliServiceItem>((item) => ({
      item,
      type: 'service',
    }))
  }

  tasks(): CliTaskItem[] {
    return Array.from(iterateWorkNodes(this.workTree)).map<CliTaskItem>((item) => ({ item, type: 'task' }))
  }

  ls(): CliItem[] {
    return [...this.services(), ...this.tasks()]
  }

  validate(): AsyncGenerator<WorkNodeValidation> {
    return validate(this.workTree, this.environment)
  }

  node(name: string): WorkItem<WorkNode> {
    const node = this.workTree.nodes[name]
    if (!node) {
      throw new Error(`unable to find task ${name}`)
    }
    return node
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
