import { BaseWorkNode } from '../work-node'
import { WorkMount } from '../work-mount'

export function getContainerMounts(task: BaseWorkNode, workMount: WorkMount[]): WorkMount[] {
  const result: WorkMount[] = [
    ...task.src.map((source) => ({
      localPath: source.absolutePath,
      containerPath: source.absolutePath,
    })),
    ...workMount,
  ]

  for (const volume of result) {
    const otherVolumes = result.filter(
      (v) => v.containerPath === volume.containerPath && v.localPath !== volume.localPath
    )
    if (otherVolumes.length > 0) {
      throw new Error(
        `duplicate container mount with different sources ${[
          volume.localPath,
          ...otherVolumes.map((ov) => ov.localPath),
        ].join(', ')}`
      )
    }
  }

  return result.filter((v, i) => result.findIndex((iv) => iv.containerPath == v.containerPath) === i)
}
