import { WorkContext } from '../work-context'
import { BuildTaskResult, findBuildTask } from './find-build-value'
import { BuildFileTask } from '../../parser/build-file-task'
import { PlannedTask } from './planned-task'
import { mapGenerate } from './map-generate'
import { BuildFileReference } from './build-file-reference'

export function planTask(workContext: WorkContext, buildTaskResult: BuildTaskResult<BuildFileTask>): PlannedTask {
  let extendedTask: BuildTaskResult<BuildFileTask> | null = null

  if (buildTaskResult.result.extend) {
    extendedTask = findBuildTask(workContext, { name: buildTaskResult.result.extend })
    if (extendedTask.result.extend) {
      throw new Error(`nested extend ${extendedTask.name} is not allowed for task ${buildTaskResult.name}`)
    }
  }

  const envs = {
    ...(extendedTask?.result?.envs || {}),
    ...buildTaskResult.context.build.envs,
    ...(buildTaskResult.result.envs || {}),
  }

  const getReferences = (task: BuildTaskResult<BuildFileTask> | null, prop: 'needs' | 'deps'): BuildFileReference[] => {
    if (!task) {
      return []
    }

    const value = task.result[prop]
    if (!value) {
      return []
    }

    return value.map((d) => ({
      name: d,
      build: buildTaskResult.context.build,
      context: task.context,
    }))
  }

  const mergeReferences = (first: BuildFileReference[], second: BuildFileReference[]): BuildFileReference[] => {
    return [...first, ...second]
  }

  return {
    buildTask: buildTaskResult.result,
    build: buildTaskResult.context.build,
    name: buildTaskResult.name,
    cache: buildTaskResult.result.cache ?? extendedTask?.result?.cache ?? null,
    description: buildTaskResult.result.description ?? extendedTask?.result?.description ?? null,
    cwd: workContext.cwd,
    image: buildTaskResult.result.image ?? extendedTask?.result?.image ?? null,
    platform: buildTaskResult.result.platform ?? extendedTask?.result?.platform ?? null,
    mounts: buildTaskResult.result.mounts || extendedTask?.result?.mounts || [],
    generates: (buildTaskResult.result.generates || extendedTask?.result?.generates || []).map((g) => mapGenerate(g)),
    shell: buildTaskResult.result.shell ?? extendedTask?.result?.shell ?? null,
    ports: buildTaskResult.result.ports || extendedTask?.result?.ports || [],
    src: buildTaskResult.result.src || extendedTask?.result?.src || [],
    cmds: buildTaskResult.result.cmds || extendedTask?.result?.cmds || [],
    continuous: buildTaskResult.result.continuous ?? extendedTask?.result?.continuous ?? false,
    labels: {
      ...(extendedTask?.result?.labels || {}),
      ...(buildTaskResult.result.labels || {}),
    },
    envs,
    deps: mergeReferences(getReferences(extendedTask, 'deps'), getReferences(buildTaskResult, 'deps')),
    needs: mergeReferences(getReferences(extendedTask, 'needs'), getReferences(buildTaskResult, 'needs')),
  }
}
