import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { createLocalCacheBackend } from './local-cache-backend'
import { environmentMock } from '../../executer/environment-mock'

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
})
