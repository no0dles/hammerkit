import { cpus as hostCpus, totalmem } from 'os'
import { WorkItem, WorkItemState } from '../planner/work-item'
import { TaskState } from './scheduler/task-state'
import { ServiceState } from './scheduler/service-state'
import { WorkTask } from '../planner/work-task'
import { WorkService } from '../planner/work-service'
import { WorkEnvironment } from '../planner/work-environment'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkServices, iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { formatQuantities } from '../planner/work-resources'
import { getContainerCli } from './execute-docker'
import { Environment } from './environment'
import { parseCpus, parseSize } from '../utils/units'
import { getErrorMessage } from '../log'

// Requests in whole millicores and bytes, so sums stay exact.
export interface ResourceAmount {
  millicores: number
  memory: number
}

export interface ResourceCapacity extends ResourceAmount {
  // what the capacity was read from, for messages
  source: string
}

type Item = WorkItem<WorkTask | WorkService>

const NONE: ResourceAmount = { millicores: 0, memory: 0 }

// Whether an item runs on the machine the run's budget covers: local tasks
// always, containers when they run on Docker. On Kubernetes the cluster
// schedules by requests itself, and a kubernetes service only forwards.
export function runsOnHost(item: Item, environment: WorkEnvironment): boolean {
  if (item.data.type === 'local-task') {
    return true
  }
  if (item.data.type === 'container-task' || item.data.type === 'container-service') {
    return environment.type === 'docker'
  }
  return false
}

export function getRequests(item: Item, environment: WorkEnvironment): ResourceAmount {
  const resources = 'resources' in item.data ? item.data.resources : null
  if (!resources || !runsOnHost(item, environment)) {
    return NONE
  }
  return {
    millicores: Math.round((resources.requests.cpus ?? 0) * 1000),
    memory: resources.requests.memory ?? 0,
  }
}

function add(a: ResourceAmount, b: ResourceAmount): ResourceAmount {
  return { millicores: a.millicores + b.millicores, memory: a.memory + b.memory }
}

function fitsIn(amount: ResourceAmount, capacity: ResourceAmount): boolean {
  return amount.millicores <= capacity.millicores && amount.memory <= capacity.memory
}

export function formatAmount(amount: ResourceAmount): string {
  return formatQuantities({ cpus: amount.millicores / 1000, memory: amount.memory })
}

// The requests of the work running on the host, against its capacity.
export class ResourceBudget {
  private used: ResourceAmount = NONE

  constructor(
    public readonly capacity: ResourceCapacity,
    private environment: WorkEnvironment
  ) {}

  requestsOf(item: Item): ResourceAmount {
    return getRequests(item, this.environment)
  }

  fits(amount: ResourceAmount): boolean {
    return fitsIn(add(this.used, amount), this.capacity)
  }

  acquire(amount: ResourceAmount): void {
    this.used = add(this.used, amount)
  }

  release(amount: ResourceAmount): void {
    this.used = { millicores: this.used.millicores - amount.millicores, memory: this.used.memory - amount.memory }
  }
}

function hasRequests(workTree: WorkTree): boolean {
  const items: Item[] = [...iterateWorkTasks(workTree), ...iterateWorkServices(workTree)]
  return items.some((item) => {
    const requests = getRequests(item, workTree.environment)
    return requests.millicores > 0 || requests.memory > 0
  })
}

// Every task and container service on the host requests both cpus and
// memory: the run is then bounded by its requests instead of a worker count.
export function requestsEverything(workTree: WorkTree): boolean {
  const items: Item[] = [...iterateWorkTasks(workTree), ...iterateWorkServices(workTree)].filter((item) =>
    runsOnHost(item, workTree.environment)
  )
  return (
    items.length > 0 &&
    items.every((item) => {
      const requests = 'resources' in item.data ? item.data.resources?.requests : null
      return !!requests && requests.cpus !== null && requests.memory !== null
    })
  )
}

// What the run may request at once: HAMMERKIT_CPUS / HAMMERKIT_MEMORY when
// set, else the Docker host's when containers run there, else this
// machine's. Null when nothing requests resources, so such a run never asks.
export async function getResourceCapacity(
  workTree: WorkTree,
  environment: Environment
): Promise<ResourceCapacity | null> {
  if (!hasRequests(workTree)) {
    return null
  }
  const capacity = await getDetectedCapacity(workTree, environment)
  const cpus = environment.processEnvs.HAMMERKIT_CPUS
  const memory = environment.processEnvs.HAMMERKIT_MEMORY
  try {
    return {
      millicores: cpus ? Math.round(parseCpus(cpus) * 1000) : capacity.millicores,
      memory: memory ? parseSize(memory) : capacity.memory,
      source: cpus || memory ? 'HAMMERKIT_CPUS/HAMMERKIT_MEMORY' : capacity.source,
    }
  } catch (e) {
    throw new Error(`HAMMERKIT_CPUS/HAMMERKIT_MEMORY: ${getErrorMessage(e)}`)
  }
}

async function getDetectedCapacity(workTree: WorkTree, environment: Environment): Promise<ResourceCapacity> {
  const host: ResourceCapacity = { millicores: hostCpus().length * 1000, memory: totalmem(), source: 'this machine' }
  const containers = [...iterateWorkTasks(workTree), ...iterateWorkServices(workTree)].some(
    (item) => item.data.type !== 'local-task' && runsOnHost(item, workTree.environment)
  )
  if (!containers || workTree.environment.type !== 'docker') {
    return host
  }
  try {
    const info = await getContainerCli(workTree.environment).info()
    if (info.NCPU > 0 && info.MemTotal > 0) {
      return { millicores: info.NCPU * 1000, memory: info.MemTotal, source: 'the docker host' }
    }
  } catch (e) {
    environment.status
      .context({ type: 'cli', name: 'hammerkit' })
      .write('debug', `unable to read the docker host's resources: ${getErrorMessage(e)}`)
  }
  return host
}

// Everything a task has running while it runs: itself and every service it
// needs, directly or through other services.
function getFootprint(task: Item, environment: WorkEnvironment): ResourceAmount {
  const services = new Map<string, Item>()
  const visit = (item: Item) => {
    for (const need of item.needs) {
      if (!services.has(need.service.name)) {
        services.set(need.service.name, need.service)
        visit(need.service)
      }
    }
  }
  visit(task)
  return [...services.values()].reduce((sum, service) => add(sum, getRequests(service, environment)), {
    ...getRequests(task, environment),
  })
}

// The work that can never fit, whatever runs after what: a task whose
// requests and those of the services it needs together exceed the capacity,
// and for `up` the services, which all run at once.
export function findOversizedWork(
  workTree: WorkTree,
  capacity: ResourceCapacity,
  up: boolean
): { item: WorkItemState<WorkTask, TaskState> | WorkItemState<WorkService, ServiceState>; message: string }[] {
  const describe = (what: string, amount: ResourceAmount) =>
    `${what} request ${formatAmount(amount)} but ${capacity.source} has ${formatAmount(capacity)}`

  const problems = []
  for (const task of iterateWorkTasks(workTree)) {
    const footprint = getFootprint(task, workTree.environment)
    if (!fitsIn(footprint, capacity)) {
      problems.push({
        item: task,
        message: describe(task.needs.length > 0 ? 'the task and the services it needs' : 'the task', footprint),
      })
    }
  }
  if (up) {
    const services = [...iterateWorkServices(workTree)]
    const total = services.reduce((sum, service) => add(sum, getRequests(service, workTree.environment)), NONE)
    if (!fitsIn(total, capacity)) {
      for (const service of services) {
        problems.push({ item: service, message: describe('the services together', total) })
      }
    }
  }
  return problems
}
