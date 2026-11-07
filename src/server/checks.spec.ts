import { mkdtempSync, rmSync, utimesSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CheckStore, getCheckRecords, isCheckRun } from './checks'
import type { Run } from './runs'

const KEY = 'a'.repeat(64)
const DAY = 24 * 60 * 60 * 1000

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run_aaaaaaaaaaaaaaaa',
    definition: 'sha256:' + 'b'.repeat(64),
    tasks: ['test'],
    accounts: [],
    source: { type: 'ref', repo: 'github.com/corp/payments', ref: 'main', commit: 'c'.repeat(40) },
    options: {},
    owner: { iss: 'https://idp', sub: 'agent' },
    state: 'failed',
    createdAt: '2026-10-25T09:00:00.000Z',
    finishedAt: '2026-10-25T09:05:00.000Z',
    results: {
      build: { status: 'succeeded', finishedAt: '2026-10-25T09:02:00.000Z', durationMs: 5, lastLog: [] },
      test: { status: 'failed', exitCode: 1, lastLog: [] },
      lint: { status: 'cached', lastLog: [] },
      deps: { status: 'skipped', lastLog: [] },
    },
    ...over,
  }
}

describe('check records', () => {
  it('are what a check run passed, with a key', () => {
    const keys = { build: KEY, test: 'd'.repeat(64), lint: 'e'.repeat(64), deps: 'f'.repeat(64) }
    const records = getCheckRecords(run(), keys)
    expect(records.map((record) => [record.task, record.status])).toEqual([
      ['build', 'succeeded'],
      ['lint', 'cached'],
    ])
    expect(records[0]).toMatchObject({
      repo: 'github.com/corp/payments',
      key: KEY,
      run: 'run_aaaaaaaaaaaaaaaa',
      by: { iss: 'https://idp', sub: 'agent' },
      source: { type: 'ref', ref: 'main', commit: 'c'.repeat(40) },
      finishedAt: '2026-10-25T09:02:00.000Z',
    })
    // a task without a key, or one the executor reported as none, is no check
    expect(getCheckRecords(run(), { build: null })).toEqual([])
    expect(getCheckRecords(run(), { build: 'not a key' })).toEqual([])
  })

  it('come from ref runs and checks of sandboxes, without arguments, only', () => {
    const sandbox = { type: 'sandbox' as const, id: 'sbx_aaaaaaaaaaaaaaaa', repo: 'x/y/z', commit: 'c', tree: 't' }
    expect(isCheckRun(run())).toBe(true)
    expect(isCheckRun(run({ source: { ...sandbox, check: true } }))).toBe(true)
    expect(isCheckRun(run({ source: sandbox }))).toBe(false)
    expect(isCheckRun(run({ source: { type: 'upload', snapshot: 'sha256:x' } }))).toBe(false)
    expect(isCheckRun(run({ options: { args: ['--grep', 'nothing'] } }))).toBe(false)
    // a run of services keeps them up, the tasks they depend on are no check
    expect(isCheckRun(run({ up: { services: ['web'], ttl: 1000, name: 'main', endpoints: [] } }))).toBe(false)
    expect(getCheckRecords(run({ source: sandbox }), { build: KEY })).toEqual([])
    expect(getCheckRecords(run({ source: { ...sandbox, check: true } }), { build: KEY })[0].source).toEqual({
      type: 'sandbox',
      sandbox: 'sbx_aaaaaaaaaaaaaaaa',
      commit: 'c',
      tree: 't',
    })
  })
})

describe('check store', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-checks-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('finds a record by repository and key until it is older than keep', async () => {
    let now = Date.parse('2026-10-25T10:00:00.000Z')
    const store = new CheckStore(directory, { keep: 30 * DAY, now: () => now })
    const [record] = getCheckRecords(run(), { build: KEY })
    await store.save([record])
    expect(await store.find('github.com/corp/payments', KEY)).toEqual(record)
    expect(await store.find('github.com/corp/other', KEY)).toBeUndefined()
    expect(await store.find('github.com/corp/payments', 'b'.repeat(64))).toBeUndefined()
    expect(await store.find('github.com/corp/payments', '../' + KEY)).toBeUndefined()
    now += 31 * DAY
    expect(await store.find('github.com/corp/payments', KEY)).toBeUndefined()
  })

  it('keeps the newest run per key and sweeps old files', async () => {
    const store = new CheckStore(directory, { keep: DAY })
    const [first] = getCheckRecords(run(), { build: KEY })
    const second = { ...first, run: 'run_bbbbbbbbbbbbbbbb', finishedAt: new Date().toISOString() }
    await store.save([first])
    await store.save([second])
    expect((await store.find(first.repo, KEY))?.run).toBe('run_bbbbbbbbbbbbbbbb')
    const [folder] = readdirSync(directory)
    const file = join(directory, folder, `${KEY}.json`)
    const old = new Date(Date.now() - 2 * DAY)
    utimesSync(file, old, old)
    await store.sweep()
    expect(readdirSync(join(directory, folder))).toEqual([])
  })
})
