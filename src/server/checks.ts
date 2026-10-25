import { createHash } from 'crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Run } from './runs'

/**
 * A task a run passed, kept so CI can see that it ran without running it (`hammerkit remote
 * verify`). It is found by its check key (check-key.ts): the task's definition and the
 * files it reads, so it counts for every commit with the same files, whoever ran it and
 * from where. Only the server writes these, from runs it executed itself.
 */
export interface CheckRecord {
  repo: string
  key: string
  task: string
  status: 'succeeded' | 'cached'
  run: string
  by: { iss: string; sub: string }
  source:
    | { type: 'ref'; ref: string; commit: string }
    // a check run on a copy of the files of a sandbox (`tree`), fetched at `commit`
    | { type: 'sandbox'; sandbox: string; commit: string; tree: string }
  // the published version of the build file the run executed
  definition: string
  accounts: string[]
  finishedAt: string
  durationMs?: number
}

export const CHECK_KEY_PATTERN = /^[0-9a-f]{64}$/

// The runs whose results are checks: those of a commit the server checked out, and those
// on a copy of the files of a sandbox, which hold nothing a commit of them would not. A run
// with arguments ran something other than the task, and is no check of it.
export function isCheckRun(run: Pick<Run, 'source' | 'options'>): boolean {
  if ((run.options.args ?? []).length > 0) {
    return false
  }
  return run.source.type === 'ref' || (run.source.type === 'sandbox' && run.source.check === true)
}

// What a run that ended passed, with the keys its executor reported before the tasks ran.
export function getCheckRecords(run: Run, keys: Record<string, string | null>): CheckRecord[] {
  if (!isCheckRun(run) || run.source.type === 'upload') {
    return []
  }
  const source: CheckRecord['source'] =
    run.source.type === 'ref'
      ? { type: 'ref', ref: run.source.ref, commit: run.source.commit }
      : { type: 'sandbox', sandbox: run.source.id, commit: run.source.commit, tree: run.source.tree }
  const records: CheckRecord[] = []
  for (const [task, result] of Object.entries(run.results ?? {})) {
    const key = keys[task]
    if (!key || !CHECK_KEY_PATTERN.test(key) || (result.status !== 'succeeded' && result.status !== 'cached')) {
      continue
    }
    records.push({
      repo: run.source.repo,
      key,
      task,
      status: result.status,
      run: run.id,
      by: { iss: run.owner.iss, sub: run.owner.sub },
      source,
      definition: run.definition,
      accounts: [...run.accounts],
      finishedAt: result.finishedAt ?? run.finishedAt ?? new Date().toISOString(),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    })
  }
  return records
}

export interface CheckStoreOptions {
  // how long a record is found after it was written (ms)
  keep: number
  now?: () => number
  log?: (line: string) => void
}

/**
 * One file per repository and key, the newest run's: `<directory>/<repo hash>/<key>.json`,
 * written to a temporary file and renamed. A record older than `keep` is not found and is
 * removed by `sweep`.
 */
export class CheckStore {
  private readonly now: () => number

  constructor(
    private readonly directory: string,
    private readonly options: CheckStoreOptions
  ) {
    this.now = options.now ?? Date.now
  }

  async save(records: CheckRecord[]): Promise<void> {
    for (const record of records) {
      const folder = join(this.directory, repoFolder(record.repo))
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const file = join(folder, `${record.key}.json`)
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
      await rename(temporary, file)
    }
  }

  async find(repo: string, key: string): Promise<CheckRecord | undefined> {
    if (!CHECK_KEY_PATTERN.test(key)) {
      return undefined
    }
    let record: CheckRecord
    try {
      record = JSON.parse(await readFile(join(this.directory, repoFolder(repo), `${key}.json`), 'utf8'))
    } catch {
      return undefined
    }
    if (record.repo !== repo || record.key !== key || this.expired(record)) {
      return undefined
    }
    return record
  }

  // Removes the records that are older than `keep`.
  async sweep(): Promise<void> {
    let folders: string[]
    try {
      folders = await readdir(this.directory)
    } catch {
      return
    }
    for (const folder of folders) {
      const path = join(this.directory, folder)
      for (const name of await readdir(path).catch(() => [] as string[])) {
        const file = join(path, name)
        const stats = await stat(file).catch(() => undefined)
        if (stats && this.now() - stats.mtimeMs > this.options.keep) {
          await rm(file, { force: true })
        }
      }
    }
  }

  private expired(record: CheckRecord): boolean {
    const at = Date.parse(record.finishedAt)
    return !Number.isFinite(at) || this.now() - at > this.options.keep
  }
}

function repoFolder(repo: string): string {
  return createHash('sha256').update(repo).digest('hex').slice(0, 32)
}
