import { createHash } from 'crypto'
import { BaseWorkTask } from '../work-task'
import { WorkVolume } from '../work-volume'
import { WorkMount } from '../work-mount'

export function generateId(generate: string): string {
  return createHash('sha1').update(generate).digest('hex')
}

export function getVolumeName(generate: string): string {
  return `hammerkit-${generateId(generate)}`
}

export function getContainerVolumes(task: BaseWorkTask, mounts: WorkMount[]): WorkVolume[] {
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
      export: generate.export,
    })
  }

  return volumes
}
