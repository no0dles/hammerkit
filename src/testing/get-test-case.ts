import { BuildFile } from '../parser/build-file'
import { Environment } from '../executer/environment'
import { ExecOptions, MockedTestCase, TestCase, TestSuiteSetupOptions } from './test-suite'
import { iterateWorkNodes, iterateWorkServices, planWorkNodes } from '../planner/utils/plan-work-nodes'
import { getExecutionMock } from '../executer/event-exec-mock'
import { UpdateEmitter } from '../executer/emitter'
import { HammerkitEvent } from '../executer/events'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { planWorkTree } from '../planner/utils/plan-work-tree'
import { createSchedulerState } from '../executer/create-scheduler-state'
import { isCI } from '../utils/ci'
import { LogMode } from '../logging/log-mode'
import { getLogger } from './get-logger'
import { watchNode } from '../executer/watch-node'
import { schedule } from '../executer/hierarchy-scheduler'
import { cleanCache, restoreCache, storeCache } from '../executer/event-cache'
import { WorkNode } from '../planner/work-node'
import { getNode } from './get-node'
import { WorkNodeValidation } from '../planner/work-node-validation'
import { validate } from '../planner/validate'
import { watchService } from '../executer/watch-service'
import { CacheMethod } from '../optimizer/cache-method'
import { WorkServices } from '../planner/work-services'
import { WorkNodes } from '../planner/work-nodes'

function startWatchProcesses(
  nodes: WorkNodes,
  services: WorkServices,
  emitter: UpdateEmitter<HammerkitEvent>,
  environment: Environment,
  cacheMethod: CacheMethod
) {
  for (const node of iterateWorkNodes(nodes)) {
    if (node.src.length > 0) {
      emitter.task(`watch:${node.id}`, watchNode(node, environment, cacheMethod))
    }
  }
  for (const service of iterateWorkServices(services)) {
    if (service.mounts.length > 0) {
      emitter.task(`watch:${service.id}`, watchService(service, environment, cacheMethod))
    }
  }
}

export function getTestCase(
  buildFile: BuildFile,
  environment: Environment,
  options?: Partial<TestSuiteSetupOptions>
): MockedTestCase | TestCase {
  const [nodes, services] = planWorkNodes(buildFile)

  const executionMock = getExecutionMock(buildFile, nodes, services, environment)
  const emitter = new UpdateEmitter<HammerkitEvent>(environment.abortCtrl.signal, (key, process) => {
    if (options?.mockExecution) {
      const mockedProcess = executionMock.getProcess(key)
      if (mockedProcess) {
        return mockedProcess
      }
    }

    return process
  })

  return {
    buildFile,
    environment,
    eventBus: emitter,
    executionMock,
    async exec(taskName: string, options?: Partial<ExecOptions>): Promise<SchedulerResult> {
      const workTree = planWorkTree(buildFile, taskName)

      const cacheMethod = options?.cacheMethod ?? 'checksum'
      const initialState = createSchedulerState({
        services: workTree.services,
        nodes: workTree.nodes,
        watch: options?.watch ?? false,
        cacheMethod: options?.cacheMethod ?? 'checksum',
        noContainer: options?.noContainer ?? false,
        workers: options?.workers ?? 0,
        logMode: options?.logMode ?? isCI ? 'live' : 'interactive',
      })
      const logMode: LogMode = options?.logMode ?? (isCI ? 'live' : 'interactive')
      const logger = getLogger(logMode, initialState, emitter)

      if (options?.watch) {
        startWatchProcesses(workTree.nodes, workTree.services, emitter, environment, cacheMethod)
      }

      const result = await schedule(emitter, initialState, environment)

      await logger.complete(result)

      return result
    },
    async clean(): Promise<void> {
      await cleanCache(nodes, services, environment)
    },
    async restore(path: string): Promise<void> {
      await restoreCache(path, nodes, services, environment)
    },
    async store(path: string): Promise<void> {
      await storeCache(path, nodes, services, environment)
    },
    getNode(name: string): WorkNode {
      const workTree = planWorkTree(buildFile, name)
      return getNode(buildFile, workTree.nodes, name)
    },
    getNodes(): Generator<WorkNode> {
      return iterateWorkNodes(nodes)
    },
    validate(): AsyncGenerator<WorkNodeValidation> {
      return validate(buildFile, environment)
    },
  }
}
