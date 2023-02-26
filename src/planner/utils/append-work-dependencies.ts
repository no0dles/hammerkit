import { isContainerWorkNode, isWorkNode, WorkNode } from '../work-node'
import { isContainerWorkService, WorkService } from '../work-service'
import { ReferenceService, ReferenceTask } from '../../schema/reference-parser'
import { appendWorkNode } from './append-work-node'
import { WorkTree } from '../work-tree'
import { Environment } from '../../executer/environment'
import { WorkItemState } from '../work-item'
import { mergeLabels } from '../../executer/label-values'
import { NodeState } from '../../executer/scheduler/node-state'
import { ServiceState } from '../../executer/scheduler/service-state'

export function appendWorkDependencies(
  workTree: WorkTree,
  referenced: ReferenceService | ReferenceTask,
  item: WorkItemState<WorkNode, NodeState> | WorkItemState<WorkService, ServiceState>,
  environment: Environment
): void {
  for (const dep of referenced.deps) {
    const depNode = appendWorkNode(workTree, dep.cwd, dep.task, environment)
    item.deps.push(depNode)

    item.data.labels = mergeLabels(item.data.labels, depNode.data.labels)

    if (isWorkNode(item.data) || isContainerWorkService(item.data)) {
      for (const src of depNode.data.src) {
        if (!item.data.src.some((s) => s.absolutePath === src.absolutePath)) {
          item.data.src.push({ ...src, inherited: true })
        }
      }
    }

    if (
      (isContainerWorkNode(depNode.data) || isContainerWorkService(depNode.data)) &&
      (isContainerWorkNode(item.data) || isContainerWorkService(item.data))
    ) {
      for (const generate of depNode.data.generates) {
        if (generate.isFile) {
          continue
        }
        if (!item.data.volumes.some((v) => v.name === generate.volumeName)) {
          item.data.volumes.push({
            name: generate.volumeName,
            export: false,
            resetOnChange: false,
            containerPath: generate.path,
            inherited: true,
          })
        }
      }
      for (const volume of depNode.data.volumes) {
        if (!item.data.volumes.some((v) => v.name === volume.name)) {
          item.data.volumes.push({
            ...volume,
            inherited: true,
          })
        }
      }
    }
  }
}
