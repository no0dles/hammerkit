import { Readable } from 'stream'

// vi.hoisted: vi.mock is hoisted above this file's top-level code, so the factory
// below can only reference variables that are themselves hoisted.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))

vi.mock('@aws-sdk/client-s3', () => {
  class S3ClientMock {
    send = sendMock
  }
  class GetObjectCommand {
    constructor(public input: any) {}
  }
  class PutObjectCommand {
    constructor(public input: any) {}
  }
  class HeadObjectCommand {
    constructor(public input: any) {}
  }
  class ListObjectsV2Command {
    constructor(public input: any) {}
  }
  return {
    S3Client: S3ClientMock,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
  }
})

import { createS3CacheBackend } from './s3-cache-backend'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { environmentMock } from '../../executer/environment-mock'

describe('s3 cache backend', () => {
  let scratch: string

  beforeEach(() => {
    sendMock.mockReset()
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-s3-spec-'))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('returns false from has() when HeadObject rejects', async () => {
    sendMock.mockRejectedValueOnce(new Error('not found'))
    const backend = createS3CacheBackend({ type: 's3', bucket: 'b', region: 'us-east-1' })
    const env = environmentMock(scratch)
    expect(await backend.has('task', 'state', env)).toBe(false)
  })

  it('returns true when HeadObject resolves', async () => {
    sendMock.mockResolvedValueOnce({})
    const backend = createS3CacheBackend({ type: 's3', bucket: 'b', region: 'us-east-1' })
    const env = environmentMock(scratch)
    expect(await backend.has('task', 'state', env)).toBe(true)
  })

  it('uploads files via PutObject with prefix + task + stateKey path', async () => {
    sendMock.mockResolvedValue({})
    const backend = createS3CacheBackend({ type: 's3', bucket: 'b', prefix: 'p/', region: 'us-east-1' })
    const env = environmentMock(scratch)
    await env.file.writeFile(join(scratch, 'stats.json'), '{}')
    await env.file.writeFile(join(scratch, 'description.json'), '{}')
    await env.file.writeFile(join(scratch, 'a-generates.tgz'), 'bytes')

    await backend.push('task1', 'key1', scratch, env)

    const keys = sendMock.mock.calls.map(([cmd]) => cmd.input.Key)
    expect(keys).toContain('p/task1/key1/a-generates.tgz')
    expect(keys).toContain('p/task1/key1/description.json')
    expect(keys).toContain('p/task1/key1/stats.json')
    // stats.json must be uploaded last so a partial push is invisible to has()/pull()
    expect(keys[keys.length - 1]).toBe('p/task1/key1/stats.json')
  })

  it('downloads files into the local cache dir on pull', async () => {
    const backend = createS3CacheBackend({ type: 's3', bucket: 'b', region: 'us-east-1' })
    const env = environmentMock(scratch)

    // Order: Head, then List, then a Get per object
    sendMock.mockResolvedValueOnce({}) // head
    sendMock.mockResolvedValueOnce({
      Contents: [{ Key: 'task/state/stats.json' }, { Key: 'task/state/dist.tgz' }],
    })
    sendMock.mockResolvedValueOnce({ Body: Readable.from(['{}']) })
    sendMock.mockResolvedValueOnce({ Body: Readable.from(['tarball']) })

    const into = join(scratch, 'pulled')
    const ok = await backend.pull('task', 'state', into, env)
    expect(ok).toBe(true)
    expect(await env.file.exists(join(into, 'stats.json'))).toBe(true)
    expect(await env.file.exists(join(into, 'dist.tgz'))).toBe(true)
  })

  it('does not write objects whose key escapes the restore dir on pull', async () => {
    const backend = createS3CacheBackend({ type: 's3', bucket: 'b', region: 'us-east-1' })
    const env = environmentMock(scratch)

    sendMock.mockResolvedValueOnce({}) // head
    sendMock.mockResolvedValueOnce({
      // a poisoned bucket can list a key whose suffix traverses out of the dir
      Contents: [{ Key: 'task/state/../escape.txt' }, { Key: 'task/state/safe.txt' }],
    })
    // only the safe object should be fetched; the traversal entry is skipped before Get
    sendMock.mockResolvedValueOnce({ Body: Readable.from(['ok']) })

    const into = join(scratch, 'pulled')
    const ok = await backend.pull('task', 'state', into, env)

    expect(ok).toBe(true)
    expect(await env.file.exists(join(into, 'safe.txt'))).toBe(true)
    // ../escape.txt would resolve to scratch/escape.txt, outside `into`
    expect(await env.file.exists(join(scratch, 'escape.txt'))).toBe(false)
    // the traversal entry must not trigger a GetObject (head + list + 1 get = 3)
    expect(sendMock).toHaveBeenCalledTimes(3)
  })
})
