import { WorkContext } from '../work-context'
import { WorkNodeGenerate } from '../work-node'
import { extname, join } from 'path'
import { templateValue } from './template-value'
import { PlannedTask } from './planned-task'

export function parseLocalWorkNodeGenerate(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkNodeGenerate[] {
  return task.generates.map((g) => {
    const filePath = join(context.cwd, templateValue(g.path, envs))
    return {
      path: filePath,
      resetOnChange: g.resetOnChange,
      export: g.export,
      isFile: extname(g.path).length > 1,
      inherited: g.inherited,
    }
  })
}
