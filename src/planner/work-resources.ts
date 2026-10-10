import { ResourceQuantitiesSchema, ResourcesSchema } from '../schema/resources-schema'
import { formatSize, parseCpus, parseSize } from '../utils/units'

export interface WorkResourceQuantities {
  // cores, a multiple of a millicore; null for none
  cpus: number | null
  // bytes; null for none
  memory: number | null
}

// A task's or service's requests and limits. As on Kubernetes, a limit
// without a request requests the same.
export interface WorkResources {
  requests: WorkResourceQuantities
  limits: WorkResourceQuantities
}

export function parseWorkResources(schema: ResourcesSchema | undefined): WorkResources | null {
  if (!schema) {
    return null
  }
  const shorthand = schema.cpus !== undefined || schema.memory !== undefined
  const limits = parseQuantities(shorthand ? schema : schema.limits)
  const requests = parseQuantities(schema.requests)
  const resources: WorkResources = {
    limits,
    requests: {
      cpus: requests.cpus ?? limits.cpus,
      memory: requests.memory ?? limits.memory,
    },
  }
  return isEmpty(resources.requests) && isEmpty(resources.limits) ? null : resources
}

function parseQuantities(schema: ResourceQuantitiesSchema | undefined): WorkResourceQuantities {
  return {
    cpus: schema?.cpus !== undefined ? parseCpus(schema.cpus) : null,
    memory: schema?.memory !== undefined ? parseSize(schema.memory) : null,
  }
}

function isEmpty(quantities: WorkResourceQuantities): boolean {
  return quantities.cpus === null && quantities.memory === null
}

export function formatQuantities(quantities: { cpus: number | null; memory: number | null }): string {
  return [
    quantities.cpus !== null ? `${quantities.cpus} cpus` : null,
    quantities.memory !== null ? `${formatSize(quantities.memory)} memory` : null,
  ]
    .filter((part) => part !== null)
    .join(', ')
}
