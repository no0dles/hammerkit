import { ResourcesSchema } from '../schema/resources-schema'
import { formatSize, parseCpus, parseSize } from '../utils/units'

// Limits of a task or service container; null fields are unlimited.
export interface WorkResources {
  // cores, a multiple of a millicore
  cpus: number | null
  // bytes
  memory: number | null
}

export function parseWorkResources(schema: ResourcesSchema | undefined): WorkResources | null {
  if (!schema || (schema.cpus === undefined && schema.memory === undefined)) {
    return null
  }
  return {
    cpus: schema.cpus !== undefined ? parseCpus(schema.cpus) : null,
    memory: schema.memory !== undefined ? parseSize(schema.memory) : null,
  }
}

export function formatWorkResources(resources: WorkResources): string {
  return [
    resources.cpus !== null ? `cpus ${resources.cpus}` : null,
    resources.memory !== null ? `memory ${formatSize(resources.memory)}` : null,
  ]
    .filter((part) => part !== null)
    .join(', ')
}
