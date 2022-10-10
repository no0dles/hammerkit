import { BuildFile } from '../parser/build-file'
import { Environment } from '../executer/environment'
import {
  ExecOptions,
  ExecTarget,
  isExecTargetTask,
  MockedTestCase,
  TestCase,
  TestSuiteSetupOptions,
} from './test-suite'
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
import { WorkServices } from '../planner/work-services'
import { WorkNodes } from '../planner/work-nodes'
import { Lazy } from './lazy'
import { isContainerWorkService } from '../planner/work-service'

function startWatchProcesses(
  nodes: WorkNodes,
  services: WorkServices,
  emitter: UpdateEmitter<HammerkitEvent>,
  environment: Environment
) {
  for (const node of iterateWorkNodes(nodes)) {
    if (node.src.length > 0) {
      emitter.task(`watch:${node.id}`, watchNode(node, environment))
    }
  }
  for (const service of iterateWorkServices(services)) {
    if (!isContainerWorkService(service)) {
      continue
    }
    if (service.mounts.length > 0) {
      emitter.task(`watch:${service.id}`, watchService(service, environment))
    }
  }
}

export function getTestCase(
  buildFile: BuildFile,
  environment: Environment,
  options?: Partial<TestSuiteSetupOptions>
): MockedTestCase | TestCase {
  const lazyWorkTree = new Lazy(() =>
    planWorkNodes(buildFile, { excludeLabels: {}, filterLabels: {}, noContainer: false })
  )
  const executionMock = getExecutionMock(buildFile, lazyWorkTree, environment)
  const emitter = new UpdateEmitter<HammerkitEvent>(environment.abortCtrl, (key, process) => {
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
    async exec(target: ExecTarget, options?: Partial<ExecOptions>): Promise<SchedulerResult> {
      const noContainer = options?.noContainer ?? false
      const workTree = isExecTargetTask(target)
        ? planWorkTree(buildFile, { taskName: target.taskName, cache: options?.cacheDefault, noContainer })
        : planWorkNodes(buildFile, {
            excludeLabels: target.excludeLabels,
            filterLabels: target.filterLabels,
            cache: options?.cacheDefault,
            noContainer,
          })

      const initialState = createSchedulerState({
        services: workTree.services,
        nodes: workTree.nodes,
        watch: options?.watch ?? false,
        workers: options?.workers ?? 0,
        logMode: options?.logMode ?? isCI ? 'live' : 'interactive',
      })
      const logMode: LogMode = options?.logMode ?? (isCI ? 'live' : 'interactive')
      const logger = getLogger(logMode, initialState, emitter)

      if (options?.watch) {
        startWatchProcesses(workTree.nodes, workTree.services, emitter, environment)
      }

      const result = await schedule(emitter, initialState, environment)

      await emitter.close()
      await logger.complete(result)

      return result
    },
    async clean(): Promise<void> {
      await cleanCache(lazyWorkTree.resolve(), environment)
    },
    async restore(path: string): Promise<void> {
      await restoreCache(path, lazyWorkTree.resolve(), environment)
    },
    async store(path: string): Promise<void> {
      await storeCache(path, lazyWorkTree.resolve(), environment)
    },
    getNode(name: string): WorkNode {
      const workTree = planWorkTree(buildFile, { taskName: name, noContainer: false })
      return getNode(buildFile, workTree.nodes, name)
    },
    getNodes(): Generator<WorkNode> {
      return iterateWorkNodes(lazyWorkTree.resolve().nodes)
    },
    validate(): AsyncGenerator<WorkNodeValidation> {
      return validate(buildFile, environment)
    },
  }
}
