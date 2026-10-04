import { WorkItem, WorkItemNeed, WorkItemState } from './work-item'
import { ContainerWorkService, WorkServiceInit } from './work-service'
import { ContainerWorkTask } from './work-task'
import { ServiceState } from '../executer/scheduler/service-state'
import { State } from '../executer/state'
import { ServiceDns } from '../executer/service-dns'

// A service's `init` runs as a one-shot container task: it needs the service
// (reachable by the service's name) and the services the service needs. The
// service is handed to it as running before its own state says so, because
// anything else needing the service may only start once the init succeeded.
export function getServiceInitTask(
  service: WorkItemState<ContainerWorkService, ServiceState>,
  init: WorkServiceInit,
  dns: ServiceDns
): WorkItem<ContainerWorkTask> {
  const self: WorkItemNeed = {
    name: service.name,
    service: {
      ...service,
      state: new State<ServiceState>({ type: 'running', dns, stateKey: '', remote: null }),
    },
  }
  return {
    id: () => `${service.id()}-init`,
    name: `${service.name}:init`,
    status: service.status,
    needs: [self, ...service.needs],
    deps: [],
    requiredBy: [],
    data: {
      type: 'container-task',
      name: `${service.name}:init`,
      cwd: service.data.cwd,
      projectRoot: service.data.projectRoot,
      description: `init of ${service.name}`,
      image: init.image,
      shell: init.shell,
      user: null,
      cmds: init.cmds,
      envs: init.envs,
      mounts: init.mounts,
      src: [],
      generates: [],
      scope: service.data.scope,
      labels: service.data.labels,
      caching: service.data.caching,
      continuous: false,
      timeout: init.timeout,
    },
  }
}
