import { createHash } from 'crypto'
import { isContainerWorkService, WorkService } from './work-service'
import { portablePath } from './utils/portable-path'
import { getVolumeName } from './utils/plan-work-volume'
import { WorkItem } from './work-item'

// The id of a service: its name in the work tree and what it runs from. Two services of
// one build file may run the same image from the same directory and differ only in their
// command, envs or network (an app's api and its worker); the name gives each its own
// container, Deployment, claim and NetworkPolicy. What the service runs is left out, so
// a service whose command changed is found again and recreated (getServiceDefinitionHash).
export function getWorkServiceId(service: WorkService): string {
  return hashServiceId({ name: service.name, ...getServiceShape(service) })
}

// The id without the name, which is all the id was up to 2.0. A task that needs the service
// caches by it (getWorkServiceCacheIdentity): to the task, a renamed service is the same.
// A container or Deployment an earlier version started carries it (getLegacyServiceItem).
export function getUnnamedWorkServiceId(service: WorkService): string {
  return hashServiceId(getServiceShape(service))
}

// The service under the id an earlier version labeled what it started with. A container or
// Deployment of it goes once, and the service starts anew under its own id, instead of
// beside the old one on the same host ports, where neither `up` nor `down` would find it.
export function getLegacyServiceItem<T extends WorkService>(item: WorkItem<T>): WorkItem<T> {
  return { ...item, id: () => getUnnamedWorkServiceId(item.data) }
}

function hashServiceId(shape: object): string {
  return createHash('sha1').update(JSON.stringify(shape)).digest('hex')
}

// Paths are made project-relative (portablePath) so a service id is identical
// wherever the project is checked out, like a task id.
function getServiceShape(service: WorkService): object {
  const portable = (path: string) => portablePath(service.projectRoot, path)
  return isContainerWorkService(service)
    ? {
        cwd: portable(service.cwd),
        image: service.image,
        volumes: service.volumes
          .map((v) =>
            // a derived volume name hashes the absolute path, so only an
            // explicitly declared name participates
            v.name === getVolumeName(v.containerPath)
              ? portable(v.containerPath)
              : `${v.name}:${portable(v.containerPath)}`
          )
          .sort(),
        src: service.src.map((s) => portable(s.absolutePath)).sort(),
        mounts: service.mounts.map((m) => m.mount).sort(),
        // only when declared, so existing services keep their ids
        ...(service.workdir ? { workdir: service.workdir } : {}),
        ...(service.shell ? { shell: service.shell } : {}),
      }
    : {
        context: service.context,
        selector: service.selector,
        kubeconfig: portable(service.kubeconfig),
      }
}
