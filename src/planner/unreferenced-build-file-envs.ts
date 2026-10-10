import { WorkTask } from './work-task'

// Build-file `envs` are passed to every task of the file and are part of every
// task's cache key, so a value only some tasks use (an image tag, a test token)
// reruns all of them when it changes. Returns the build-file envs the task's own
// definition never mentions as `$NAME` / `${NAME}`. The task may still read
// them implicitly at runtime (NODE_ENV), so this is only worth a warning.
export function getUnreferencedBuildFileEnvs(task: WorkTask): string[] {
  const buildFileEnvs = task.scope.schema.envs ?? {}
  const taskSchema = getTaskSchema(task)
  // an aggregate (deps only) runs nothing, so a rerun costs nothing
  if (!taskSchema || 'extend' in taskSchema || (taskSchema.cmds ?? []).length === 0) {
    return []
  }
  const taskEnvs: { [key: string]: unknown } = taskSchema.envs ?? {}
  const definition = JSON.stringify(taskSchema)
  return Object.keys(buildFileEnvs)
    .filter((name) => !(name in taskEnvs))
    .filter((name) => !isReferenced(definition, name))
}

function getTaskSchema(task: WorkTask): { [key: string]: any } | null {
  const prefix = task.scope.namePrefix.length > 0 ? `${task.scope.namePrefix}:` : ''
  if (!task.name.startsWith(prefix)) {
    return null
  }
  const tasks: { [key: string]: any } = task.scope.schema.tasks ?? {}
  return tasks[task.name.substring(prefix.length)] ?? null
}

function isReferenced(definition: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\$(\\{${escaped}\\}|${escaped}(?![A-Za-z0-9_]))`, 'i').test(definition)
}
