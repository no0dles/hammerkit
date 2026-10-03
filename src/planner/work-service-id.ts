import { createHash } from 'crypto'
import { isContainerWorkService, WorkService } from './work-service'
import { portablePath } from './utils/portable-path'
import { getVolumeName } from './utils/plan-work-volume'

// Paths are made project-relative (portablePath) so a service id is identical
// wherever the project is checked out, like a task id.
export function getWorkServiceId(service: WorkService): string {
  const portable = (path: string) => portablePath(service.projectRoot, path)
  const jsonData = JSON.stringify(
    isContainerWorkService(service)
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
          ...(service.shell ? { shell: service.shell } : {}),
        }
      : {
          context: service.context,
          selector: service.selector,
          kubeconfig: portable(service.kubeconfig),
        }
  )
  return createHash('sha1').update(jsonData).digest('hex')
}
