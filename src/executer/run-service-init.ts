import { WorkItem, WorkItemState } from '../planner/work-item'
import { ContainerWorkService, WorkServiceInit } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { getServiceInitTask } from '../planner/service-init-task'
import { ServiceState } from './scheduler/service-state'
import { TaskState } from './scheduler/task-state'
import { State } from './state'
import { ServiceDns } from './service-dns'
import { ExecuteOptions } from '../runtime/runtime'
import { AbortError } from './abort'
import { withDeadline } from './deadline'
import { formatDuration } from '../utils/units'

export type InitTaskRunner = (task: WorkItem<ContainerWorkTask>, options: ExecuteOptions<TaskState>) => Promise<void>

// Run a service's `init` once its healthcheck passed, through the runtime's
// container task path, and fail the service when the init fails. The service
// only counts as running afterwards, so nothing needing it starts too early.
export async function runServiceInit(
  service: WorkItem<ContainerWorkService>,
  init: WorkServiceInit,
  dns: ServiceDns,
  options: ExecuteOptions<ServiceState>,
  runTask: InitTaskRunner
): Promise<void> {
  service.status.write('info', `run init of ${service.name}`)
  const task = getServiceInitTask(service as WorkItemState<ContainerWorkService, ServiceState>, init, dns)
  const state = new State<TaskState>({ type: 'pending', stateKey: null })
  const deadline = withDeadline(options.abort, init.timeout)
  try {
    await runTask(task, {
      cache: { cached: false, stateKey: options.stateKey, resolved: service.data.caching, provable: false },
      stateKey: `${options.stateKey}-init`,
      abort: deadline.signal,
      state,
      daemon: false,
      publishPorts: false,
      waitForReady: true,
    })
  } finally {
    deadline.clear()
  }

  const result = state.current
  if (result.type === 'canceled') {
    if (deadline.expired()) {
      throw new Error(`init of ${service.name} timed out after ${formatDuration(init.timeout)}`)
    }
    throw new AbortError()
  }
  if (result.type === 'crash') {
    throw new Error(`init of ${service.name} failed with exit code ${result.exitCode} (see its log above)`)
  }
  if (result.type === 'error') {
    throw new Error(`init of ${service.name} failed: ${result.errorMessage}`)
  }
  service.status.write('info', `init of ${service.name} done`)
}
