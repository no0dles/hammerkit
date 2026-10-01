import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { createLocalCacheBackend } from './local-cache-backend'
import { environmentMock } from '../../executer/environment-mock'
import { prunable } from '../../testing/prunable-backend'
import { CacheEntry } from '../cache-backend'

function entryOf(entries: CacheEntry[], taskId: string): CacheEntry {
  const entry = entries.find((e) => e.taskId === taskId)
  if (!entry) {
    throw new Error(`no entry for ${taskId}`)
  }
  return entry
}

describe('local cache backend', () => {
  let root: string
  let scratch: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-local-cache-'))
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-local-cache-scratch-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  })

  it('reports no hit when nothing pushed yet', async () => {
    const env = environmentMock(scratch)
    const backend = createLocalCacheBackend({ type: 'local', path: root })
    expect(await backend.has('taskA', 'key1', env)).toBe(false)
    expect(await backend.pull('taskA', 'key1', join(scratch, 'pull'), env)).toBe(false)
  })

  it('round-trips a task through push and pull', async () => {
    const env = environmentMock(scratch)
    const backend = createLocalCacheBackend({ type: 'local', path: root })

    const sourceDir = join(scratch, 'src')
    await env.file.createDirectory(sourceDir)
    await env.file.writeFile(join(sourceDir, 'stats.json'), '{"files":{}}')
    await env.file.writeFile(join(sourceDir, 'description.json'), '{}')
    await env.file.writeFile(join(sourceDir, 'dist-generates.tgz'), 'tarball-bytes')

    await backend.push('taskA', 'key1', sourceDir, env)
    expect(await backend.has('taskA', 'key1', env)).toBe(true)

    const into = join(scratch, 'pull')
    const ok = await backend.pull('taskA', 'key1', into, env)
    expect(ok).toBe(true)
    expect(await env.file.exists(join(into, 'stats.json'))).toBe(true)
    expect(await env.file.exists(join(into, 'description.json'))).toBe(true)
    expect(await env.file.exists(join(into, 'dist-generates.tgz'))).toBe(true)
    expect(await env.file.read(join(into, 'dist-generates.tgz'))).toBe('tarball-bytes')
  })

  it('isolates entries by stateKey', async () => {
    const env = environmentMock(scratch)
    const backend = createLocalCacheBackend({ type: 'local', path: root })

    const sourceDir = join(scratch, 'src')
    await env.file.createDirectory(sourceDir)
    await env.file.writeFile(join(sourceDir, 'stats.json'), '{}')

    await backend.push('taskA', 'key1', sourceDir, env)
    expect(await backend.has('taskA', 'key2', env)).toBe(false)
  })

  it('clear removes every state key of a task without touching others', async () => {
    const env = environmentMock(scratch)
    const backend = createLocalCacheBackend({ type: 'local', path: root })

    const sourceDir = join(scratch, 'src')
    await env.file.createDirectory(sourceDir)
    await env.file.writeFile(join(sourceDir, 'stats.json'), '{}')

    await backend.push('taskA', 'key1', sourceDir, env)
    await backend.push('taskA', 'key2', sourceDir, env)
    await backend.push('taskB', 'key1', sourceDir, env)

    await backend.clear('taskA', env)

    expect(await backend.has('taskA', 'key1', env)).toBe(false)
    expect(await backend.has('taskA', 'key2', env)).toBe(false)
    expect(await backend.has('taskB', 'key1', env)).toBe(true)
  })

  it('clear is a no-op when the task has nothing cached', async () => {
    const env = environmentMock(scratch)
    const backend = createLocalCacheBackend({ type: 'local', path: root })
    await expect(backend.clear('missing', env)).resolves.toBeUndefined()
  })

  async function pushEntry(backend: ReturnType<typeof createLocalCacheBackend>, taskId: string, stateKey: string) {
    const env = environmentMock(scratch)
    const sourceDir = join(scratch, `src-${taskId}-${stateKey}`)
    await env.file.createDirectory(sourceDir)
    await env.file.writeFile(join(sourceDir, 'stats.json'), '{"files":{}}')
    await env.file.writeFile(join(sourceDir, 'out-generates.tgz'), 'x'.repeat(1000))
    await backend.push(taskId, stateKey, sourceDir, env)
  }

  it('lists entries with size, creation time and last access', async () => {
    const env = environmentMock(scratch)
    const backend = prunable(createLocalCacheBackend({ type: 'local', path: root }))
    await pushEntry(backend, 'taskA', 'key1')
    await pushEntry(backend, 'taskB', 'key2')

    const before = await backend.list(env)
    expect(before.map((e) => `${e.taskId}/${e.stateKey}`).sort()).toEqual(['taskA/key1', 'taskB/key2'])
    const entry = entryOf(before, 'taskA')
    expect(entry.size).toBe(1000 + '{"files":{}}'.length)
    expect(entry.createdAt).toBeGreaterThan(Date.now() - 60_000)
    expect(entry.lastAccessedAt).toBeNull()

    // a pull records the access, and the marker never leaks into the restore
    const into = join(scratch, 'pulled')
    expect(await backend.pull('taskA', 'key1', into, env)).toBe(true)
    expect((await env.file.listFiles(into)).sort()).toEqual(['out-generates.tgz', 'stats.json'])
    const after = entryOf(await backend.list(env), 'taskA')
    expect(after.lastAccessedAt).toBeGreaterThan(Date.now() - 60_000)
    expect(after.size).toBe(entry.size)
  })

  it('does not list an entry whose push has not completed', async () => {
    const env = environmentMock(scratch)
    const backend = prunable(createLocalCacheBackend({ type: 'local', path: root }))
    await env.file.createDirectory(join(root, 'taskA', 'partial'))
    await env.file.writeFile(join(root, 'taskA', 'partial', 'out-generates.tgz'), 'x')
    expect(await backend.list(env)).toEqual([])
  })

  it('removes a single entry', async () => {
    const env = environmentMock(scratch)
    const backend = prunable(createLocalCacheBackend({ type: 'local', path: root }))
    await pushEntry(backend, 'taskA', 'key1')
    await pushEntry(backend, 'taskA', 'key2')
    await backend.remove('taskA', 'key1', env)
    expect(await backend.has('taskA', 'key1', env)).toBe(false)
    expect(await backend.has('taskA', 'key2', env)).toBe(true)
    await backend.remove('taskA', 'key2', env)
    expect(await env.file.exists(join(root, 'taskA'))).toBe(false)
  })
})
