import { isContainerWorkTask, isWorkTask, WorkTask } from '../work-task'
import { isContainerWorkService, WorkService } from '../work-service'
import { ReferencedContext, ReferenceService, ReferenceTask } from '../../schema/reference-parser'
import { appendWorkTask } from './append-work-task'
import { WorkTree } from '../work-tree'
import { Environment } from '../../executer/environment'
import { WorkItemState } from '../work-item'
import { mergeLabels } from '../../executer/label-values'
import { TaskState } from '../../executer/scheduler/task-state'
import { ServiceState } from '../../executer/scheduler/service-state'

export function appendWorkDependencies(
  workTree: WorkTree,
  referenced: ReferenceService | ReferenceTask,
  item: WorkItemState<WorkTask, TaskState> | WorkItemState<WorkService, ServiceState>,
  environment: Environment,
  context: ReferencedContext
): void {
  for (const dep of referenced.deps) {
    const depNode = appendWorkTask(workTree, dep.cwd, dep.task, environment, context)
    item.deps.push(depNode)

    item.data.labels = mergeLabels(item.data.labels, depNode.data.labels)

    if (isWorkTask(item.data) || isContainerWorkService(item.data)) {
      for (const src of depNode.data.src) {
        if (!item.data.src.some((s) => s.absolutePath === src.absolutePath)) {
          item.data.src.push({ ...src, inherited: depNode })
        }
      }
    }

    if (
      (isContainerWorkTask(depNode.data) || isContainerWorkService(depNode.data)) &&
      (isContainerWorkTask(item.data) || isContainerWorkService(item.data))
    ) {
      for (const generate of depNode.data.generates) {
        if (generate.isFile) {
          // TODO check if thats correct
          continue
        }
        if (item.data.type === 'container-service') {
          if (!item.data.volumes.some((v) => v.name === generate.volumeName)) {
            item.data.volumes.push({
              name: generate.volumeName,
              export: false,
              resetOnChange: false,
              containerPath: generate.path,
              inherited: depNode,
            })
          }
        } else {
          if (!item.data.generates.some((v) => v.volumeName === generate.volumeName)) {
            item.data.generates.push({
              volumeName: generate.volumeName,
              export: false,
              resetOnChange: false,
              path: generate.path,
              inherited: depNode,
              isFile: false,
            })
          }
        }
      }
    }
  }
}
