import { V1ResourceRequirements } from '@kubernetes/client-node'
import { WorkResourceQuantities, WorkResources } from '../planner/work-resources'

// A container's `resources` for its declared requests and limits; nothing
// without, so the spec stays as before. A request beyond the cluster's
// capacity leaves the pod Pending, which the running-state wait surfaces.
export function getKubernetesResources(resources: WorkResources | null): { resources?: V1ResourceRequirements } {
  if (!resources) {
    return {}
  }
  const requirements: V1ResourceRequirements = {}
  const requests = toQuantities(resources.requests)
  const limits = toQuantities(resources.limits)
  if (requests) {
    requirements.requests = requests
  }
  if (limits) {
    requirements.limits = limits
  }
  return { resources: requirements }
}

function toQuantities(quantities: WorkResourceQuantities): { [key: string]: string } | null {
  const result: { [key: string]: string } = {}
  if (quantities.cpus !== null) {
    result.cpu = `${Math.round(quantities.cpus * 1000)}m`
  }
  if (quantities.memory !== null) {
    result.memory = `${quantities.memory}`
  }
  return Object.keys(result).length > 0 ? result : null
}
