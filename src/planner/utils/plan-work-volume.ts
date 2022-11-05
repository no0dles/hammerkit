import { createHash } from 'crypto'
import { BaseWorkNode } from '../work-node'
import { WorkVolume } from '../work-volume'

export function generateId(generate: string): string {
  return createHash('sha1').update(generate).digest('hex')
}

export function getVolumeName(generate: string): string {
  return `hammerkit-${generateId(generate)}`
}

export function getContainerVolumes(task: BaseWorkNode): WorkVolume[] {
  const volumes: WorkVolume[] = []

  for (const generate of task.generates) {
    const name = getVolumeName(generate.path)
    volumes.push({
      name,
      containerPath: generate.path,
    })
  }

  return volumes
}
