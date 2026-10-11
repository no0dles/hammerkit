import { createHash } from 'crypto'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { Principal } from './oauth'
import { SourceError, SourceStore, subjectKey } from './sources'

const principal = (sub: string): Principal => ({ iss: 'https://idp.corp', sub, groups: [], claims: {} })
const alice = principal('alice')
const bob = principal('bob')

const digestOf = (content: string) => createHash('sha256').update(content).digest('hex')
const entry = (path: string, content: string) => ({
  path,
  sha256: digestOf(content),
  size: Buffer.byteLength(content),
  mode: 'file' as const,
})
const body = (content: string) => Readable.from([Buffer.from(content)])

describe('SourceStore', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-sources-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('says which content is missing and completes when it was sent', async () => {
    const store = new SourceStore(directory)
    const { status, created } = await store.announce(alice, { files: [entry('a.txt', 'one'), entry('b.txt', 'two')] })
    expect(created).toBe(true)
    expect(status.missing.sort()).toEqual([digestOf('one'), digestOf('two')].sort())

    expect(await store.put(alice, digestOf('one'), body('one'))).toBe('created')
    expect((await store.get(alice, status.snapshot))?.missing).toEqual([digestOf('two')])
    expect(await store.put(alice, digestOf('two'), body('two'))).toBe('created')
    expect((await store.get(alice, status.snapshot))?.missing).toEqual([])
  })

  it('sends a file that two paths share once, and sends nothing again for a tree it knows', async () => {
    const store = new SourceStore(directory)
    const files = [entry('a.txt', 'same'), entry('copy/a.txt', 'same')]
    const first = await store.announce(alice, { files })
    expect(first.status.missing).toEqual([digestOf('same')])
    await store.put(alice, digestOf('same'), body('same'))
    expect(await store.put(alice, digestOf('same'), body('same'))).toBe('exists')

    const again = await store.announce(alice, { files })
    expect(again.created).toBe(false)
    expect(again.status.missing).toEqual([])
  })

  it('only sends what a new tree lacks', async () => {
    const store = new SourceStore(directory)
    const one = await store.announce(alice, { files: [entry('a.txt', 'one'), entry('b.txt', 'two')] })
    await store.put(alice, digestOf('one'), body('one'))
    await store.put(alice, digestOf('two'), body('two'))
    expect(one.status.missing).toHaveLength(2)

    const edited = await store.announce(alice, { files: [entry('a.txt', 'one'), entry('b.txt', 'two, edited')] })
    expect(edited.status.snapshot).not.toBe(one.status.snapshot)
    expect(edited.status.missing).toEqual([digestOf('two, edited')])
  })

  it('refuses content it was not told about, or that is not what was announced', async () => {
    const store = new SourceStore(directory)
    await store.announce(alice, { files: [entry('a.txt', 'one')] })
    await expect(store.put(alice, digestOf('other'), body('other'))).rejects.toThrow('not part of a tree')
    await expect(store.put(alice, digestOf('one'), body('uno'))).rejects.toThrow(SourceError)
    await expect(store.put(alice, digestOf('one'), body('one, and more'))).rejects.toThrow('larger')
    await expect(store.put(alice, digestOf('one'), body('on'))).rejects.toThrow('2 bytes, 3 were')
    // nothing half written is left behind
    expect(existsSync(join(directory, subjectKey(alice), 'blobs', digestOf('one')))).toBe(false)
    await expect(store.put(alice, 'nope', body(''))).rejects.toMatchObject({ status: 404 })
  })

  it('refuses a tree with a file that may not leave the machine', async () => {
    const store = new SourceStore(directory)
    const error = await store
      .announce(alice, { files: [entry('src/a.ts', 'x'), entry('.env', 'TOKEN=1'), entry('keys/a.pem', 'k')] })
      .catch((e) => e)
    expect(error).toMatchObject({ status: 400 })
    expect(error.message).toContain('2 files may not be sent')
    expect(error.message).toContain('.env')
    expect((await store.list(alice)).snapshots).toEqual([])
  })

  it('keeps one digest to one size', async () => {
    const store = new SourceStore(directory)
    await store.announce(alice, { files: [entry('a.txt', 'one')] })
    const lying = { ...entry('b.txt', 'one'), size: 99 }
    await expect(store.announce(alice, { files: [lying] })).rejects.toThrow('two sizes')
  })

  it('keeps callers apart: nobody sees, takes or deletes the tree or content of another', async () => {
    const store = new SourceStore(directory)
    const { status } = await store.announce(alice, { files: [entry('a.txt', 'secret plans')] })
    await store.put(alice, digestOf('secret plans'), body('secret plans'))

    expect(await store.get(bob, status.snapshot)).toBeUndefined()
    expect(await store.remove(bob, status.snapshot)).toBe(false)
    expect((await store.list(bob)).snapshots).toEqual([])
    // bob announcing the same file does not learn that alice has it
    const theirs = await store.announce(bob, { files: [entry('a.txt', 'secret plans')] })
    expect(theirs.status.missing).toEqual([digestOf('secret plans')])
    expect(theirs.status.snapshot).toBe(status.snapshot)
    expect((await store.get(alice, status.snapshot))?.missing).toEqual([])
  })

  it('stops at the quota of a caller, and takes a deleted tree back out of it', async () => {
    const store = new SourceStore(directory, { subjectBytes: 10 })
    const big = await store.announce(alice, { files: [entry('a.txt', '123456')] })
    await store.put(alice, digestOf('123456'), body('123456'))
    await store.announce(alice, { files: [entry('b.txt', '654321')] })
    await expect(store.put(alice, digestOf('654321'), body('654321'))).rejects.toMatchObject({ status: 413 })
    expect((await store.list(alice)).bytes).toBe(6)

    expect(await store.remove(alice, big.status.snapshot)).toBe(true)
    expect((await store.list(alice)).bytes).toBe(0)
    expect(await store.put(alice, digestOf('654321'), body('654321'))).toBe('created')
  })

  it('keeps content that another tree still needs when one is deleted', async () => {
    const store = new SourceStore(directory)
    const a = await store.announce(alice, { files: [entry('a.txt', 'shared'), entry('x', 'only a')] })
    const b = await store.announce(alice, { files: [entry('a.txt', 'shared')] })
    await store.put(alice, digestOf('shared'), body('shared'))
    await store.put(alice, digestOf('only a'), body('only a'))

    expect(await store.remove(alice, a.status.snapshot)).toBe(true)
    expect(existsSync(join(directory, subjectKey(alice), 'blobs', digestOf('only a')))).toBe(false)
    expect((await store.get(alice, b.status.snapshot))?.missing).toEqual([])
    expect(await store.get(alice, a.status.snapshot)).toBeUndefined()
  })

  it('remembers its trees and content after a restart', async () => {
    const first = new SourceStore(directory)
    const { status } = await first.announce(alice, { files: [entry('a.txt', 'one'), entry('b.txt', 'two')] })
    await first.put(alice, digestOf('one'), body('one'))

    const second = new SourceStore(directory)
    expect((await second.get(alice, status.snapshot))?.missing).toEqual([digestOf('two')])
    expect(await second.put(alice, digestOf('two'), body('two'))).toBe('created')
    expect((await second.list(alice)).bytes).toBe(6)
  })

  it('does not take anything that is not a tree name', async () => {
    const store = new SourceStore(directory)
    expect(await store.get(alice, 'latest')).toBeUndefined()
    expect(await store.get(alice, '../../etc')).toBeUndefined()
    expect(await store.remove(alice, 'sha256:zz')).toBe(false)
  })
})
