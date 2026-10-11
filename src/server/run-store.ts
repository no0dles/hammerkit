import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { RUN_ID_PATTERN, Run, StoredEvent } from './runs'

export interface RunRecord {
  run: Run
  events: StoredEvent[]
}

// Where the registry keeps its runs so a restart does not lose who is waiting for an
// approval, nor what finished runs said.
export interface RunStore {
  save(record: RunRecord): Promise<void>
  remove(id: string): Promise<void>
  load(): Promise<{ records: RunRecord[]; skipped: string[] }>
}

/**
 * One file per run, written to a temporary file and renamed, so a crash leaves the
 * old record and not half a new one. A record holds what the server already shows
 * the caller: the state, the plan, the logs as they were masked. Only the user of the
 * server can read the files.
 */
export class FileRunStore implements RunStore {
  constructor(private readonly directory: string) {}

  async save(record: RunRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `${record.run.id}.json`)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await rename(temporary, file)
  }

  async remove(id: string): Promise<void> {
    await rm(join(this.directory, `${id}.json`), { force: true })
  }

  async load(): Promise<{ records: RunRecord[]; skipped: string[] }> {
    const records: RunRecord[] = []
    const skipped: string[] = []
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch {
      return { records, skipped }
    }
    for (const name of names) {
      if (!name.endsWith('.json')) {
        // a record that was being written when the server stopped
        if (name.endsWith('.tmp')) {
          await rm(join(this.directory, name), { force: true })
        }
        continue
      }
      try {
        const record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as RunRecord
        if (!RUN_ID_PATTERN.test(record.run.id) || `${record.run.id}.json` !== name || !Array.isArray(record.events)) {
          throw new Error('not a run record')
        }
        records.push(record)
      } catch {
        skipped.push(name)
      }
    }
    records.sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt))
    return { records, skipped }
  }
}
