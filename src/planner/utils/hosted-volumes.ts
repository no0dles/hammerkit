import { WorkTree } from '../work-tree'
import { isContainerWorkService } from '../work-service'
import { WorkVolume } from '../work-volume'

// What Docker takes as the name of a volume. Anything else in a service's `volumes` is a
// path of the host to Docker (`/var/run/docker.sock:/run/docker.sock` binds the socket).
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/

export function isVolumeName(name: string): boolean {
  return VOLUME_NAME.test(name)
}

/**
 * On a server, the docker volumes of a run's services are its caller's: each name gets the
 * run's scope (its caller and source trust) in front, so a build file can neither open nor,
 * with `resetOnChange`, remove a volume of another caller, of a sandbox or of the host.
 * The outputs a service inherits from its deps keep their names: those are made from paths
 * in the run's own files, and the task that writes them uses the same name. A Kubernetes
 * backend keeps claims in the caller's namespace and is left as it is.
 */
export function scopeServiceVolumes(workTree: WorkTree, scope: string): void {
  const scoped = new Set<WorkVolume>()
  for (const service of Object.values(workTree.services)) {
    if (!isContainerWorkService(service.data)) {
      continue
    }
    for (const volume of service.data.volumes) {
      if (!volume.inherited && !scoped.has(volume)) {
        scoped.add(volume)
        volume.name = `hammerkit-${scope}-${volume.name}`
      }
    }
  }
}
