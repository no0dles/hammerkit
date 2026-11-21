import { existsSync, WriteStream } from 'fs'
import { mkdir, rm, stat, writeFile } from 'fs/promises'
import { isAbsolute, join, posix, relative, sep } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { Environment } from '../executer/environment'
import { TaskState } from '../executer/scheduler/task-state'
import { getErrorMessage } from '../log'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { WorkItemState } from '../planner/work-item'
import { isAggregateTask, WorkTask, WorkTaskGenerate } from '../planner/work-task'
import { WorkTree } from '../planner/work-tree'
import { ArchiveWritten } from '../runtime/runtime'
import { extractOutput, measureArchive, packArchive } from '../utils/tar'
import { formatSize } from '../utils/units'
import { ARTIFACTS_MANIFEST, ArtifactsManifest } from './run-artifacts'

// The most entries an output may have when it is unpacked: what the server packs again.
export const MAX_OUTPUT_ENTRIES = 10_000

// Why the outputs of a task that came from the cache are not kept: a cache is shared by the
// runs of the server, and its key holds no value of a secret, so what an entry holds may be
// what a run that read a secret wrote, and this run may read none.
const CACHE_REASON =
  'it came from the cache: the cache is shared by the runs of this server and its key holds no secret value, ' +
  'so what it holds may be what a run that read a secret wrote'

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
  let bytes = 0
  try {
    const tasks = [...iterateWorkTasks(workTree)].sort((a, b) => a.name.localeCompare(b.name))
    for (const task of tasks) {
      for (const generate of getKeptOutputs(task)) {
        const path = toPosix(relative(options.root, generate.path))
        const file = `${manifest.outputs.length + manifest.left.length}.tgz`
        const target = join(options.directory, file)
        if (options.cancelled()) {
          manifest.left.push({ task: task.name, path, reason: 'the run was cancelled' })
          continue
        }
        if (isFromCache(task)) {
          manifest.left.push({ task: task.name, path, reason: CACHE_REASON })
          continue
        }
        try {
          const kept = await keepOutput(task, generate, keeping, {
            staging,
            target,
            root: options.root,
            maxBytes: options.maxBytes,
            remaining: options.maxBytes - bytes,
          })
          if (kept === null) {
            manifest.left.push({ task: task.name, path, reason: 'the task left nothing there' })
          } else {
            bytes += kept
            manifest.outputs.push({ task: task.name, path, file, bytes: kept })
          }
        } catch (e) {
          await rm(target, { force: true })
          // what this module says of the limit is ours to say, what else went wrong is redacted
          const reason = e instanceof Refused ? e.message : options.redact(getErrorMessage(e)).slice(0, 500)
          manifest.left.push({ task: task.name, path, reason })
        }
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  await writeFile(join(options.directory, ARTIFACTS_MANIFEST), JSON.stringify(manifest))
  return manifest
}

// The outputs of a task a run may keep: what its build file exports, of a task that completed,
// and what it exports always of one that failed. What it inherits is its dependency's to keep.
// A task that was skipped, as nothing needed it, has none. Those of a task that came from the
// cache are candidates too, and are refused in keepArtifacts (isFromCache).
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

function isFromCache(task: WorkItemState<WorkTask, TaskState>): boolean {
  const state = task.state.current
  return state.type === 'completed' && !!state.cached
}

// A refusal of one output, with what the run may say of it.
class Refused extends Error {}

function overBudget(maxBytes: number, detail?: string): string {
  return `more than the ${formatSize(maxBytes)} a run keeps (runs.artifacts.maxBytes)${detail ? `, ${detail}` : ''}`
}

/**
 * What the archives of one output may still take: the rest of the run's budget. Past it a
 * write is refused and the stream writing the archive stops there, so a task can not fill the
 * disk of the server with an output that is refused in the end.
 */
class Budget {
  private used = 0
  private refusal: Error | undefined

  constructor(
    private readonly limit: number,
    private readonly reason: string
  ) {}

  take(bytes: number): void {
    this.used += bytes
    if (this.used > this.limit) {
      throw new Refused(this.reason)
    }
  }

  // a stream that writes an archive, metered: what passes it counts
  meter(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        try {
          this.take(chunk.length)
          callback(null, chunk)
        } catch (e) {
          callback(e as Error)
        }
      },
    })
  }

  // a file an archive is written to, metered at its writes: past the limit it is destroyed
  count(file: WriteStream): WriteStream {
    const write = file.write.bind(file) as (chunk: unknown, ...rest: unknown[]) => boolean
    file.on('error', (error) => {
      this.refusal ??= error
    })
    file.write = ((chunk: Buffer | string, ...rest: unknown[]) => {
      if (this.refusal) {
        return false
      }
      try {
        this.take(Buffer.byteLength(chunk))
      } catch (e) {
        file.destroy(e as Error)
        return false
      }
      return write(chunk, ...rest)
    }) as WriteStream['write']
    return file
  }

  // throws what refused a write, when a stream did not say it by itself
  check(): void {
    if (this.refusal) {
      throw this.refusal
    }
  }
}

// The environment with its writes of archives counted by the budget: the runtimes write their
// archives through `file`, so every byte an output is archived with is counted here.
function budgeted(environment: Environment, budget: Budget): Environment {
  const { file } = environment
  return {
    ...environment,
    file: {
      ...file,
      writeStream: (path, stream) => {
        const metered = budget.meter()
        // the source is stopped where the meter stops it; the error reaches the write through `metered`
        pipeline(stream, metered).catch(() => undefined)
        return file.writeStream(path, metered)
      },
      createWriteStream: (path) => budget.count(file.createWriteStream(path)),
    },
  }
}

// The archive of one output as the runtime of its task makes it, made again with the paths
// in the project: the size of the new archive, or null when there is nothing.
async function keepOutput(
  task: WorkItemState<WorkTask, TaskState>,
  generate: WorkTaskGenerate,
  environment: Environment,
  options: { staging: string; target: string; root: string; maxBytes: number; remaining: number }
): Promise<number | null> {
  const raw = join(options.staging, 'raw')
  const tree = join(options.staging, 'tree')
  await rm(raw, { recursive: true, force: true })
  await rm(tree, { recursive: true, force: true })
  await mkdir(raw, { recursive: true })
  const budget = new Budget(options.remaining, overBudget(options.maxBytes))
  const [archive] = await task.runtime.archive(budgeted(environment, budget), raw, { only: [generate.path] })
  budget.check()
  if (!archive || !existsSync(archive.filename)) {
    return null
  }
  await checkArchive(archive, options)
  const into = join(tree, relative(options.root, archive.root))
  if (relative(tree, into).startsWith('..') || isAbsolute(relative(tree, into))) {
    throw new Error(`${archive.root} is not in the project`)
  }
  await mkdir(into, { recursive: true })
  // only entries of the output, and no link out of it: whatever the task wrote there
  await extractOutput(archive.filename, into, toPosix(relative(archive.root, generate.path)) || '.', true)
  const path = relative(options.root, generate.path)
  if (!existsSync(join(tree, path))) {
    return null
  }
  await packArchive({ cwd: tree, file: options.target, gzip: true, portable: true }, [toPosix(path)])
  const packed = (await stat(options.target)).size
  if (packed > options.remaining) {
    throw new Refused(overBudget(options.maxBytes, `${formatSize(packed)} packed`))
  }
  return packed
}

// What an archive holds once it is unpacked is measured before it is, so a few bytes packed
// from a huge file, or from many files, are refused before anything is written.
async function checkArchive(archive: ArchiveWritten, options: { maxBytes: number; remaining: number }): Promise<void> {
  const measured = await measureArchive(archive.filename, { entries: MAX_OUTPUT_ENTRIES, bytes: options.remaining })
  if (measured.entries > MAX_OUTPUT_ENTRIES) {
    throw new Refused(`more than ${MAX_OUTPUT_ENTRIES} files in it`)
  }
  if (measured.bytes > options.remaining) {
    throw new Refused(overBudget(options.maxBytes, `${formatSize(measured.bytes)} unpacked`))
  }
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep)
}
