import { V1ResourceRequirements } from '@kubernetes/client-node'
import { WorkResources } from '../planner/work-resources'

// A container's `resources` for declared limits, requesting what it limits so
// the scheduler places the pod where they fit. Nothing without limits, so the
// spec stays as before; a request beyond the cluster's capacity leaves the pod
// Pending, which the running-state wait surfaces.
export function getKubernetesResources(resources: WorkResources | null): { resources?: V1ResourceRequirements } {
  if (!resources) {
    return {}
  }
  const quantities: { [key: string]: string } = {}
  if (resources.cpus !== null) {
    quantities.cpu = `${Math.round(resources.cpus * 1000)}m`
  }
  if (resources.memory !== null) {
    quantities.memory = `${resources.memory}`
  }
  return { resources: { requests: { ...quantities }, limits: { ...quantities } } }
}
