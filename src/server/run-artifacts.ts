import { createReadStream } from 'fs'
import { readdir, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { formatDuration, formatSize } from '../utils/units'
import { getCredentialReads, TaskPlan } from './plan'
import type { Run } from './runs'

// What the process of a run kept of the files its tasks generated, written as
// `artifacts.json` beside the archives once it is done: the server serves only what it lists.
export const ARTIFACTS_MANIFEST = 'artifacts.json'

export interface ArtifactsManifest {
  // why the run keeps none
  refused?: string
  // a gzipped tar per output, its entries the paths in the project (`app/screenshots/a.png`)
  outputs: { task: string; path: string; file: string; bytes: number }[]
  // outputs it would have kept, and why it did not
  left: { task: string; path: string; reason: string }[]
}

/**
 * Why a run keeps none of the files its tasks generated, or null when it keeps them. Its
 * outputs are handed out as they are, never masked: a task or service of the run that reads
 * a secret or a variable of the server (but the plain ones) can write it into a file, its
 * own or one a task after it reads and copies (an `.npmrc`, a docker `config.json`), as it
 * could print it past the masking with an argument (task-arguments FR-008). So any of them
 * leaves the whole run without artifacts.
 */
export function refuseArtifacts(plan: Record<string, TaskPlan>): string | null {
  for (const [name, item] of Object.entries(plan).sort(([a], [b]) => a.localeCompare(b))) {
    const reads = getCredentialReads(item)
    if (reads.length > 0) {
      return `${name} reads ${reads.join(', ')}: what it writes can reach the outputs of the run, which keeps none`
    }
  }
  return null
}

// What `GET /v1/runs/<id>/artifacts` answers of a run that ended: its outputs by number, those
// it would have kept and why not, until when they stay, or why there are none.
export interface ArtifactsAnswer {
  outputs: { id: number; task: string; path: string; bytes: number }[]
  left: ArtifactsManifest['left']
  expiresAt?: string
  reason?: string
}

// Run ids name the directories: nothing else is taken from the store's folder
const RUN_DIRECTORY = /^run_[A-Za-z0-9_-]+$/

/**
 * The outputs runs kept, a directory per run below `directory`, written by its process
 * (keepArtifacts) or its executor. They stay `keep` from the end of their run, while the
 * registry keeps the run, and the newest runs' only while all together take at most `total`.
 */
export class ArtifactStore {
  constructor(
    private readonly directory: string,
    private readonly options: { keep: number; total: number }
  ) {}

  directoryOf(id: string): string {
    if (!RUN_DIRECTORY.test(id)) {
      throw new Error(`${id} is not a run id`)
    }
    return join(this.directory, id)
  }

  // A run that ended; who may read it was checked already.
  async read(run: Run, now: number): Promise<ArtifactsAnswer> {
    if (run.up) {
      return { outputs: [], left: [], reason: 'a service run keeps no outputs' }
    }
    const manifest = await this.manifest(run, now)
    if (!manifest) {
      return {
        outputs: [],
        left: [],
        reason: `the server has no outputs of the run: it keeps what tasks export (export: true, or always) for ${formatDuration(
          this.options.keep
        )}, and ${formatSize(this.options.total)} of all runs, the newest`,
      }
    }
    return {
      outputs: manifest.outputs.map((output, id) => ({
        id,
        task: output.task,
        path: output.path,
        bytes: output.bytes,
      })),
      left: manifest.left,
      ...(manifest.refused ? { reason: manifest.refused } : { expiresAt: this.expiresAt(run).toISOString() }),
    }
  }

  // The archive of one output: a gzipped tar of its paths in the project.
  async open(
    run: Run,
    id: number,
    now: number
  ): Promise<{ bytes: number; stream: () => Readable; read: () => Promise<Buffer> } | undefined> {
    const output = (await this.manifest(run, now))?.outputs[id]
    if (!output || !/^\d+\.tgz$/.test(output.file)) {
      return undefined
    }
    const file = join(this.directoryOf(run.id), output.file)
    const bytes = (await stat(file).catch(() => undefined))?.size
    return bytes === undefined ? undefined : { bytes, stream: () => createReadStream(file), read: () => readFile(file) }
  }

  /**
   * Removes what is over its time, what runs the registry no longer has kept, and of the
   * runs that ended the oldest while all of them take more than `total`. A run that has not
   * ended may still write. Answers the runs it removed the outputs of.
   */
  async sweep(lookup: (id: string) => Run | undefined, now: number): Promise<string[]> {
    const names = await readdir(this.directory).catch(() => [] as string[])
    const removed: string[] = []
    const ended: { id: string; finishedAt: number; bytes: number }[] = []
    for (const id of names.filter((name) => RUN_DIRECTORY.test(name))) {
      const run = lookup(id)
      if (run && !run.finishedAt) {
        continue
      }
      if (!run || this.expiresAt(run).getTime() <= now) {
        await this.remove(id)
        removed.push(id)
        continue
      }
      const manifest = await this.readManifest(id)
      const bytes = manifest?.outputs.reduce((sum, output) => sum + output.bytes, 0) ?? 0
      ended.push({ id, finishedAt: Date.parse(run.finishedAt as string), bytes })
    }
    let total = ended.reduce((sum, run) => sum + run.bytes, 0)
    for (const run of ended.sort((a, b) => a.finishedAt - b.finishedAt)) {
      if (total <= this.options.total) {
        break
      }
      await this.remove(run.id)
      removed.push(run.id)
      total -= run.bytes
    }
    return removed
  }

  private expiresAt(run: Run): Date {
    return new Date(Date.parse(run.finishedAt ?? '') + this.options.keep)
  }

  // what the run kept, while it is kept
  private async manifest(run: Run, now: number): Promise<ArtifactsManifest | undefined> {
    if (!run.finishedAt || this.expiresAt(run).getTime() <= now) {
      return undefined
    }
    return this.readManifest(run.id)
  }

  private async readManifest(id: string): Promise<ArtifactsManifest | undefined> {
    try {
      return JSON.parse(await readFile(join(this.directoryOf(id), ARTIFACTS_MANIFEST), 'utf8')) as ArtifactsManifest
    } catch {
      return undefined
    }
  }

  private async remove(id: string): Promise<void> {
    await rm(this.directoryOf(id), { recursive: true, force: true })
  }
}
