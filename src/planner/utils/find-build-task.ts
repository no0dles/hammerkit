import { BuildFile } from '../../parser/build-file'
import { BuildFileTask } from '../../parser/build-file-task'
import { splitName } from './split-name'

export function findBuildTask(build: BuildFile, taskName: string): { task: BuildFileTask; build: BuildFile } {
  if (build.tasks[taskName]) {
    return { task: build.tasks[taskName], build }
  } else {
    const ref = splitName(taskName)
    if (ref.prefix && build.includes[ref.prefix]) {
      return findBuildTask(build.includes[ref.prefix], ref.taskName)
    }

    throw new Error(`unable to find ${taskName} in ${build.path}`)
  }
}
