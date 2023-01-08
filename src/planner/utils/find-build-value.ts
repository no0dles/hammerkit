import { createSubWorkContext, WorkContext } from '../work-context'
import { ExecutionBuildService } from '../../parser/build-file-service'
import { BuildFileTask } from '../../parser/build-file-task'
import { BuildFile } from '../../parser/build-file'
import { splitName } from './split-name'

export type BuildTaskResult<T> = { result: T; name: string; context: WorkContext }
export type BuildFileNameSelector = { name: string }

export function findBuildService(
  context: WorkContext,
  selector: BuildFileNameSelector
): BuildTaskResult<ExecutionBuildService> {
  return findBuildValue<ExecutionBuildService>(context, selector, (build, name) => build.services[name])
}

export function findBuildTask(context: WorkContext, selector: BuildFileNameSelector): BuildTaskResult<BuildFileTask> {
  return findBuildValue<BuildFileTask>(context, selector, (build, name) => build.tasks[name])
}

function findBuildValue<T>(
  context: WorkContext,
  selector: BuildFileNameSelector,
  resolver: (buildFile: BuildFile, name: string) => T
): BuildTaskResult<T> {
  const result = resolver(context.build, selector.name)
  if (result) {
    return { result, context, name: selector.name }
  } else {
    const ref = splitName(selector.name)
    if (ref.prefix) {
      if (context.build.references[ref.prefix]) {
        return findBuildValue(
          createSubWorkContext(context, {
            name: ref.prefix,
            type: 'references',
          }),
          { name: ref.name },
          resolver
        )
      } else if (context.build.includes[ref.prefix]) {
        return findBuildValue(
          createSubWorkContext(context, {
            name: ref.prefix,
            type: 'includes',
          }),
          {
            name: ref.name,
          },
          resolver
        )
      }
    }

    throw new Error(`unable to find ${selector.name} in ${context.build.path}`)
  }
}
