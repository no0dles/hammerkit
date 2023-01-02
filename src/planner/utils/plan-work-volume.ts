import { createHash } from 'crypto'
import { BaseWorkNode } from '../work-node'
import { WorkVolume } from '../work-volume'
import { WorkMount } from '../work-mount'

export function generateId(generate: string): string {
  return createHash('sha1').update(generate).digest('hex')
}

export function getVolumeName(generate: string): string {
  return `hammerkit-${generateId(generate)}`
}

export function getContainerVolumes(task: BaseWorkNode, mounts: WorkMount[]): WorkVolume[] {
  const volumes: WorkVolume[] = []

  for (const generate of task.generates) {
    const hasMount = mounts.some((m) => m.containerPath === generate.path)
    if (hasMount) {
      continue
    }

    const name = getVolumeName(generate.path)
    volumes.push({
      resetOnChange: generate.resetOnChange,
      name,
      containerPath: generate.path,
      inherited: generate.inherited,
    })
  }

  return volumes
}
