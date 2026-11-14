import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { environmentMock } from '../executer/environment-mock'
import { calculateChecksum, racyWindow } from './calculate-checksum'

describe('calculateChecksum', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-checksum-'))
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('returns the sha256 of the file contents', async () => {
    const env = environmentMock(scratch)
    const file = join(scratch, 'a.txt')
    writeFileSync(file, 'hello world')

    const expected = createHash('sha256').update('hello world').digest('hex')
    expect(await calculateChecksum(env, file)).toBe(expected)
  })

  it('is deterministic and content-sensitive', async () => {
    const env = environmentMock(scratch)
    const file = join(scratch, 'a.txt')

    writeFileSync(file, 'one')
    const first = await calculateChecksum(env, file)
    expect(await calculateChecksum(env, file)).toBe(first)

    writeFileSync(file, 'two')
    expect(await calculateChecksum(env, file)).not.toBe(first)
  })

  // every task of a run hashes the sources of what it depends on too: ci:check of
  // iwentsourcing read each file about ten times
  describe('with the stats of the file', () => {
    const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000)

    function counting(env: ReturnType<typeof environmentMock>) {
      const reads: string[] = []
      const readStream = env.file.readStream.bind(env.file)
      env.file.readStream = (path: string) => {
        reads.push(path)
        return readStream(path)
      }
      return reads
    }

    it('reads a file once while it stays the same file', async () => {
      const env = environmentMock(scratch)
      const reads = counting(env)
      const file = join(scratch, 'a.txt')
      writeFileSync(file, 'one')
      utimesSync(file, anHourAgo(), anHourAgo())
      // setting the times is a change too, which has to be older than the window
      await new Promise((resolve) => setTimeout(resolve, 60))

      const first = await calculateChecksum(env, file, (await env.file.stats(file)) as any)
      const second = await calculateChecksum(env, file, (await env.file.stats(file)) as any)

      expect(second).toBe(first)
      expect(second).toBe(createHash('sha256').update('one').digest('hex'))
      expect(reads).toEqual([file])
    })

    it('reads it again once it was written, also with the same size and modification time', async () => {
      const env = environmentMock(scratch)
      const reads = counting(env)
      const file = join(scratch, 'a.txt')
      const time = anHourAgo()
      writeFileSync(file, 'one')
      utimesSync(file, time, time)
      await new Promise((resolve) => setTimeout(resolve, 60))
      await calculateChecksum(env, file, (await env.file.stats(file)) as any)

      // what a checkout that restores the time does: only the change time tells
      writeFileSync(file, 'two')
      utimesSync(file, time, time)
      const after = await calculateChecksum(env, file, (await env.file.stats(file)) as any)

      expect(after).toBe(createHash('sha256').update('two').digest('hex'))
      expect(reads).toEqual([file, file])
    })

    it('keeps no checksum of a file changed right before it was hashed', async () => {
      const env = environmentMock(scratch)
      const reads = counting(env)
      const file = join(scratch, 'a.txt')
      writeFileSync(file, 'one')

      await calculateChecksum(env, file, (await env.file.stats(file)) as any)
      await calculateChecksum(env, file, (await env.file.stats(file)) as any)

      expect(reads).toEqual([file, file])
    })

    it('waits longer on a file system that keeps whole seconds', () => {
      expect(racyWindow({ lastModified: 1700000000000, identity: { changed: 1700000001000 } })).toBe(2000)
      expect(racyWindow({ lastModified: 1700000000123.5, identity: { changed: 1700000000123.5 } })).toBe(50)
    })

    it('reads it every time without them', async () => {
      const env = environmentMock(scratch)
      const reads = counting(env)
      const file = join(scratch, 'a.txt')
      writeFileSync(file, 'one')
      utimesSync(file, anHourAgo(), anHourAgo())

      await calculateChecksum(env, file)
      await calculateChecksum(env, file)

      expect(reads).toEqual([file, file])
    })
  })
})
