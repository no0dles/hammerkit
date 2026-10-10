import { posix, relative, sep } from 'path'
import { WorkItem } from './work-item'
import { isContainerWorkTask, WorkEnvOrigin, WorkTask } from './work-task'

const toPosix = (value: string): string => (sep === posix.sep ? value : value.split(sep).join(posix.sep))

// What `explain --definition` shows of a task: the definition as hammerkit
// resolved it, where it came from and where each env value was declared.
export interface TaskDefinition {
  name: string
  type: 'local' | 'container'
  description: string | null
  source: {
    // relative to the repository for a remote file, to the working directory otherwise
    file: string
    // the name the including file gave it, empty for the main build file
    includedAs: string
    git: string | null
    ref: string | null
    commit: string | null
  }
  image: string | null
  shell: string
  cmds: string[]
  src: string[]
  generates: string[]
  deps: string[]
  needs: string[]
  mounts: string[]
  envs: { name: string; value: string; origin: WorkEnvOrigin }[]
  // variables taken from the process environment or a .env file, never their values
  envReferences: { name: string; from: string; available: boolean }[]
}

export function describeTask(item: WorkItem<WorkTask>, cwd: string): TaskDefinition {
  const task = item.data
  const remote = task.scope.remote
  return {
    name: item.name,
    type: isContainerWorkTask(task) ? 'container' : 'local',
    description: task.description || null,
    source: {
      file: toPosix(remote ? relative(remote.root, task.scope.fileName) : relative(cwd, task.scope.fileName)),
      includedAs: task.scope.namePrefix,
      git: remote?.git ?? null,
      ref: remote?.ref ?? null,
      commit: remote?.commit ?? null,
    },
    image: isContainerWorkTask(task) ? task.image : null,
    shell: task.shell,
    cmds: task.cmds.map((cmd) => cmd.cmd),
    src: task.src.map((src) => src.source),
    generates: task.generates.map((generate) => relative(task.cwd, generate.path)),
    deps: item.deps.map((dep) => dep.name),
    needs: item.needs.map((need) => need.name),
    mounts: isContainerWorkTask(task) ? task.mounts.map((mount) => mount.mount) : [],
    envs: Object.entries(task.envs.variables).map(([name, value]) => ({
      name,
      value,
      origin: task.envOrigins[name] ?? 'task',
    })),
    envReferences: task.envs.replacements.map((replacement) => ({
      name: replacement.key,
      from: replacement.name,
      available: replacement.available,
    })),
  }
}
