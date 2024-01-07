import { CliExecResult } from '../cli'
import { iterateWorkServices, iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { WorkItemState } from '../planner/work-item'

export async function testingTimeout(exec: CliExecResult, timeout?: number) {
  const timer = setTimeout(
    () => {
      for (const task of iterateWorkTasks(exec.state.current)) {
        printWorkItem(task)
      }
      for (const service of iterateWorkServices(exec.state.current)) {
        printWorkItem(service)
      }
    },
    (timeout || 45 * 1000) - 2000
  )
  try {
    return await exec.start()
  } finally {
    clearTimeout(timer)
  }
}

function printWorkItem(task: WorkItemState<any, any>) {
  const messages = [` - ${task.name}: ${task.state.current.type}`]
  for (const log of task.status.logs()) {
    messages.push(` console ${log.console}: ${log.message}`)
  }
  for (const log of task.status.read()) {
    messages.push(` status ${log.level}: ${log.message}`)
  }
  console.log(messages.join('\n'))
}
