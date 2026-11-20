import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ArtifactStore, ARTIFACTS_MANIFEST, ArtifactsManifest, refuseArtifacts } from './run-artifacts'
import { TaskPlan } from './plan'
import { Run } from './runs'

function item(patch: Partial<TaskPlan> = {}): TaskPlan {
  return {
    kind: 'task',
    runtime: 'docker',
    image: 'node',
    cmds: ['npm test'],
    deps: [],
    needs: [],
    accounts: [],
    secrets: [],
    mounts: [],
    ports: [],
    generates: ['screenshots'],
    flags: [],
    ...patch,
  } as TaskPlan
}

describe('refuseArtifacts', () => {
  it('keeps the outputs of a run in which nothing reads a credential', () => {
    expect(refuseArtifacts({ test: item(), build: item(), db: item({ kind: 'service' } as Partial<TaskPlan>) })).toBe(
      null
    )
  })

  it('keeps none of a run in which a task reads a secret, a dependency or a service', () => {
    const secret = { from: 'gsm:npm-token', account: 'ci', target: 'NPM_TOKEN' }
    expect(refuseArtifacts({ test: item({ deps: ['install'] }), install: item({ secrets: [secret] }) })).toBe(
      'install reads the secret NPM_TOKEN: what it writes can reach the outputs of the run, which keeps none'
    )
    expect(refuseArtifacts({ test: item({ needs: ['db'] }), db: item({ secrets: [secret] }) })).toMatch(/^db reads/)
  })

  it('keeps none of a run that reads a variable of the server, but the plain ones', () => {
    expect(refuseArtifacts({ test: item({ serverEnvs: ['PATH', 'HOME', 'CI'] }) })).toBe(null)
    expect(refuseArtifacts({ test: item({ serverEnvs: ['PATH', 'DEPLOY_KEY'] }) })).toBe(
      'test reads $DEPLOY_KEY of the server: what it writes can reach the outputs of the run, which keeps none'
    )
  })
})

describe('ArtifactStore', () => {
  let root: string
  const HOUR = 60 * 60 * 1000
  const now = Date.parse('2026-11-20T12:00:00.000Z')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-artifacts-'))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const run = (id: string, finishedAt?: string, patch: Partial<Run> = {}): Run =>
    ({ id, state: finishedAt ? 'failed' : 'running', ...(finishedAt ? { finishedAt } : {}), ...patch }) as Run

  // what a run's process leaves: an archive per output and the manifest
  function kept(store: ArtifactStore, id: string, manifest: ArtifactsManifest) {
    const directory = store.directoryOf(id)
    mkdirSync(directory, { recursive: true })
    for (const output of manifest.outputs) {
      writeFileSync(join(directory, output.file), 'x'.repeat(output.bytes))
    }
    writeFileSync(join(directory, ARTIFACTS_MANIFEST), JSON.stringify(manifest))
  }

  const screenshots = (bytes = 10) => ({
    outputs: [{ task: 'e2e', path: 'app/screenshots', file: '0.tgz', bytes }],
    left: [{ task: 'e2e', path: 'app/videos', reason: 'more than the 10B a run keeps' }],
  })

  it('lists what a run kept, numbered, until when, and serves each archive', async () => {
    const store = new ArtifactStore(root, { keep: 24 * HOUR, total: 1024 })
    kept(store, 'run_a', screenshots())
    const finished = run('run_a', '2026-11-20T11:00:00.000Z')
    expect(await store.read(finished, now)).toEqual({
      outputs: [{ id: 0, task: 'e2e', path: 'app/screenshots', bytes: 10 }],
      left: [{ task: 'e2e', path: 'app/videos', reason: 'more than the 10B a run keeps' }],
      expiresAt: '2026-11-21T11:00:00.000Z',
    })
    const opened = await store.open(finished, 0, now)
    expect(opened?.bytes).toBe(10)
    expect(await opened?.read()).toEqual(Buffer.from('x'.repeat(10)))
    expect(await store.open(finished, 1, now)).toBeUndefined()
  })

  it('says why a run has none', async () => {
    const store = new ArtifactStore(root, { keep: 24 * HOUR, total: 1024 })
    kept(store, 'run_secret', { refused: 'deploy reads the secret TOKEN: …', outputs: [], left: [] })
    expect(await store.read(run('run_secret', '2026-11-20T11:00:00.000Z'), now)).toMatchObject({
      outputs: [],
      reason: 'deploy reads the secret TOKEN: …',
    })
    expect(await store.read(run('run_old', '2026-11-20T11:00:00.000Z'), now)).toEqual({
      outputs: [],
      left: [],
      reason:
        'the server has no outputs of the run: it keeps what tasks export (export: true, or always) for 1d, and 1Ki of all runs, the newest',
    })
    expect(await store.read(run('run_up', '2026-11-20T11:00:00.000Z', { up: {} as Run['up'] }), now)).toMatchObject({
      reason: 'a service run keeps no outputs',
    })
    // kept, but over its time
    kept(store, 'run_late', screenshots())
    expect(await store.read(run('run_late', '2026-11-19T11:00:00.000Z'), now)).toMatchObject({ outputs: [] })
    expect(await store.open(run('run_late', '2026-11-19T11:00:00.000Z'), 0, now)).toBeUndefined()
  })

  it('removes what is over its time, of runs the server no longer keeps, and the oldest over the total', async () => {
    const store = new ArtifactStore(root, { keep: 24 * HOUR, total: 25 })
    kept(store, 'run_expired', screenshots())
    kept(store, 'run_forgotten', screenshots())
    kept(store, 'run_oldest', screenshots())
    kept(store, 'run_older', screenshots())
    kept(store, 'run_newest', screenshots())
    // still running: its process writes there
    mkdirSync(store.directoryOf('run_running'))
    const runs: Record<string, Run> = {
      run_expired: run('run_expired', '2026-11-19T11:59:00.000Z'),
      run_oldest: run('run_oldest', '2026-11-20T09:00:00.000Z'),
      run_older: run('run_older', '2026-11-20T10:00:00.000Z'),
      run_newest: run('run_newest', '2026-11-20T11:00:00.000Z'),
      run_running: run('run_running'),
    }
    expect((await store.sweep((id) => runs[id], now)).sort()).toEqual(['run_expired', 'run_forgotten', 'run_oldest'])
    expect(readdirSync(root).sort()).toEqual(['run_newest', 'run_older', 'run_running'])
  })
})
