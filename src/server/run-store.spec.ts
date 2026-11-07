import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileRunStore, RunRecord } from './run-store'

const record = (id: string, createdAt: string): RunRecord => ({
  run: {
    id,
    owner: { iss: 'https://idp.corp', sub: 'alice' },
    definition: 'sha256:' + 'a'.repeat(64),
    tasks: ['build'],
    accounts: [],
    source: { type: 'upload', snapshot: 'snap' },
    options: {},
    state: 'succeeded',
    createdAt,
  },
  events: [{ seq: 1, time: createdAt, type: 'state', state: 'succeeded' }],
})

describe('FileRunStore', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-run-store-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('loads what was saved, oldest first, and replaces a record that is saved again', async () => {
    const store = new FileRunStore(join(directory, 'records'))
    await store.save(record('run_bbbbbbbbbbbbbbbb', '2026-01-02T00:00:00.000Z'))
    await store.save(record('run_aaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z'))
    const changed = record('run_bbbbbbbbbbbbbbbb', '2026-01-02T00:00:00.000Z')
    changed.run.state = 'failed'
    await store.save(changed)

    const { records, skipped } = await store.load()
    expect(skipped).toEqual([])
    expect(records.map((r) => [r.run.id, r.run.state])).toEqual([
      ['run_aaaaaaaaaaaaaaaa', 'succeeded'],
      ['run_bbbbbbbbbbbbbbbb', 'failed'],
    ])
  })

  it('writes records only the user of the server can read, and no temporary files stay', async () => {
    const store = new FileRunStore(join(directory, 'records'))
    await store.save(record('run_aaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z'))
    expect(readdirSync(join(directory, 'records'))).toEqual(['run_aaaaaaaaaaaaaaaa.json'])
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, 'records', 'run_aaaaaaaaaaaaaaaa.json')).mode & 0o077).toBe(0)
    }
  })

  it('keeps only the hash of the build file a run of an older server named', async () => {
    const old = record('run_aaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    const hash = old.run.definition
    writeFileSync(
      join(directory, 'run_aaaaaaaaaaaaaaaa.json'),
      JSON.stringify({ ...old, run: { ...old.run, definition: { name: 'payments', hash } } })
    )
    const { records } = await new FileRunStore(directory).load()
    expect(records[0].run.definition).toBe(hash)
  })

  it('removes a record, and what is not there is no error', async () => {
    const store = new FileRunStore(directory)
    await store.save(record('run_aaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z'))
    await store.remove('run_aaaaaaaaaaaaaaaa')
    await store.remove('run_aaaaaaaaaaaaaaaa')
    expect((await store.load()).records).toEqual([])
  })

  it('has nothing to load before the first run', async () => {
    expect(await new FileRunStore(join(directory, 'none')).load()).toEqual({ records: [], skipped: [] })
  })

  it('skips records it can not trust and cleans up what a crash left', async () => {
    const store = new FileRunStore(directory)
    await store.save(record('run_aaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z'))
    writeFileSync(join(directory, 'run_bbbbbbbbbbbbbbbb.json'), '{ not json')
    // the name must be the id of the run it holds
    writeFileSync(
      join(directory, 'run_cccccccccccccccc.json'),
      JSON.stringify(record('run_dddddddddddddddd', '2026-01-01T00:00:00.000Z'))
    )
    writeFileSync(join(directory, 'run_eeeeeeeeeeeeeeee.json.1.tmp'), 'half')

    const { records, skipped } = await store.load()
    expect(records.map((r) => r.run.id)).toEqual(['run_aaaaaaaaaaaaaaaa'])
    expect(skipped.sort()).toEqual(['run_bbbbbbbbbbbbbbbb.json', 'run_cccccccccccccccc.json'])
    expect(readdirSync(directory)).not.toContain('run_eeeeeeeeeeeeeeee.json.1.tmp')
  })
})
