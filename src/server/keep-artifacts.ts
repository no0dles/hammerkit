import { existsSync } from 'fs'
import { mkdir, rm, stat, writeFile } from 'fs/promises'
import { dirname, join, posix, relative, sep } from 'path'
import { Environment } from '../executer/environment'
import { getArchivePaths } from '../executer/event-cache'
import { getErrorMessage } from '../log'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { WorkItemState } from '../planner/work-item'
import { TaskState } from '../executer/scheduler/task-state'
import { isAggregateTask, WorkTask, WorkTaskGenerate } from '../planner/work-task'
import { WorkTree } from '../planner/work-tree'
import { extractOutput, packArchive } from '../utils/tar'
import { formatSize } from '../utils/units'
import { ARTIFACTS_MANIFEST, ArtifactsManifest } from './run-artifacts'

export interface KeepArtifactsOptions {
  // where the archives and the manifest go
  directory: string
  // what the archives of the run may take together (`runs.artifacts.maxBytes`)
  maxBytes: number
  // the root of the project, which the paths of the outputs are kept relative to
  root: string
  // the run was stopped: what is not kept yet stays out
  cancelled: () => boolean
  redact: (text: string) => string
}

/**
 * Keeps the outputs of the tasks of a run that the build file says to copy out (`export`),
 * as a run on a dev machine copies them out of their containers: those of a task that
 * completed, and those with `export: always` of one that failed too. Each goes through the
 * runtime its task ran on, as `hammerkit store` takes it, and is kept as a gzipped tar of
 * its paths in the project, so a download is laid out the same whatever ran it.
 */
export async function keepArtifacts(
  workTree: WorkTree,
  environment: Environment,
  options: KeepArtifactsOptions
): Promise<ArtifactsManifest> {
  const manifest: ArtifactsManifest = { outputs: [], left: [] }
  const staging = join(options.directory, '.staging')
  await mkdir(staging, { recursive: true })
  // a failed task aborts the run's controller, the archives still have to be made
  const keeping: Environment = { ...environment, abortCtrl: new AbortController() }
  const kubernetes = workTree.environment.type === 'kubernetes'
  let bytes = 0
  try {
    const tasks = [...iterateWorkTasks(workTree)].sort((a, b) => a.name.localeCompare(b.name))
    for (const task of tasks) {
      for (const generate of getKeptOutputs(task)) {
        const path = toPosix(relative(options.root, generate.path))
        if (options.cancelled()) {
          manifest.left.push({ task: task.name, path, reason: 'the run was cancelled' })
          continue
        }
        const file = `${manifest.outputs.length + manifest.left.length}.tgz`
        try {
          const kept = await keepOutput(task, generate, keeping, {
            staging,
            target: join(options.directory, file),
            root: options.root,
            kubernetes,
          })
          if (kept === null) {
            manifest.left.push({ task: task.name, path, reason: 'the task left nothing there' })
          } else if (bytes + kept > options.maxBytes) {
            await rm(join(options.directory, file), { force: true })
            manifest.left.push({
              task: task.name,
              path,
              reason: `more than the ${formatSize(
                options.maxBytes
              )} a run keeps (runs.artifacts.maxBytes), ${formatSize(kept)} packed`,
            })
          } else {
            bytes += kept
            manifest.outputs.push({ task: task.name, path, file, bytes: kept })
          }
        } catch (e) {
          await rm(join(options.directory, file), { force: true })
          manifest.left.push({ task: task.name, path, reason: options.redact(getErrorMessage(e)).slice(0, 500) })
        }
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  await writeFile(join(options.directory, ARTIFACTS_MANIFEST), JSON.stringify(manifest))
  return manifest
}

// The outputs of a task a run keeps: what its build file exports, of a task that ran or came
// from the cache, and what it exports always of one that failed. What it inherits is its
// dependency's to keep.
function getKeptOutputs(task: WorkItemState<WorkTask, TaskState>): WorkTaskGenerate[] {
  const state = task.state.current
  if (isAggregateTask(task.data)) {
    return []
  }
  const completed = state.type === 'completed' && !state.skipped
  const failed = state.type === 'crash' || state.type === 'error'
  return task.data.generates.filter(
    (generate) =>
      !generate.inherited && (generate.exportAlways || (generate.export && completed)) && (completed || failed)
  )
}

// The archive of one output as the runtime of its task makes it, made again with the paths
// in the project: the size of the new archive, or null when there is nothing.
async function keepOutput(
  task: WorkItemState<WorkTask, TaskState>,
  generate: WorkTaskGenerate,
  environment: Environment,
  options: { staging: string; target: string; root: string; kubernetes: boolean }
): Promise<number | null> {
  const raw = join(options.staging, 'raw')
  const tree = join(options.staging, 'tree')
  await rm(raw, { recursive: true, force: true })
  await rm(tree, { recursive: true, force: true })
  await mkdir(raw, { recursive: true })
  await task.runtime.archive(environment, raw, undefined, [generate.path])
  const [archive] = getArchivePaths(task.data, raw, [generate.path])
  if (!archive || !existsSync(archive.filename)) {
    return null
  }
  const from = getArchiveRoot(task, generate, options.kubernetes)
  const into = join(tree, relative(options.root, from))
  await mkdir(into, { recursive: true })
  // only entries of the output, and no link out of it: whatever the task wrote there
  await extractOutput(archive.filename, into, toPosix(relative(from, generate.path)) || '.', true)
  const path = relative(options.root, generate.path)
  if (!existsSync(join(tree, path))) {
    return null
  }
  await packArchive({ cwd: tree, file: options.target, gzip: true, portable: true }, [toPosix(path)])
  return (await stat(options.target)).size
}

// The directory the entries of the archive of an output are relative to, as each runtime
// packs it: a local task's from its directory (archiveLocal), a directory a container
// generates by its name on Docker (getArchive) and by its content on Kubernetes (`tar -C`),
// a file by its name.
export function getArchiveRoot(
  task: WorkItemState<WorkTask, TaskState>,
  generate: WorkTaskGenerate,
  kubernetes: boolean
): string {
  if (task.data.type === 'local-task') {
    return task.data.cwd
  }
  if (generate.isFile || !kubernetes) {
    return dirname(generate.path)
  }
  return generate.path
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep)
}
