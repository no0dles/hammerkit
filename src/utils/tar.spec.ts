import fs, { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { extract } from 'tar'
import { packArchive } from './tar'

describe('utils/tar', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-tar-'))
    mkdirSync(join(root, 'source', 'node_modules', 'sub'), { recursive: true })
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, 'source', 'node_modules', `file-${i}.js`), `content ${i}`)
      linkSync(
        join(root, 'source', 'node_modules', `file-${i}.js`),
        join(root, 'source', 'node_modules', `link-${i}.js`)
      )
      linkSync(
        join(root, 'source', 'node_modules', `file-${i}.js`),
        join(root, 'source', 'node_modules', 'sub', `link-${i}.js`)
      )
    }
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function expectRestored(dir: string): void {
    for (let i = 0; i < 5; i++) {
      for (const path of [`file-${i}.js`, `link-${i}.js`, join('sub', `link-${i}.js`)]) {
        expect(readFileSync(join(dir, 'node_modules', path), 'utf8')).toBe(`content ${i}`)
      }
      // links are kept where the file id is exact (see packArchive), on Windows not always
      if (Number.isSafeInteger(statSync(join(root, 'source', 'node_modules', `file-${i}.js`)).ino)) {
        const file = statSync(join(dir, 'node_modules', `file-${i}.js`))
        expect(file.nlink).toBe(3)
        expect(statSync(join(dir, 'node_modules', `link-${i}.js`)).ino).toBe(file.ino)
        expect(statSync(join(dir, 'node_modules', 'sub', `link-${i}.js`)).ino).toBe(file.ino)
      }
    }
  }

  // node-tar 7.5.14 and later hang on a directory with several hard links, or fail with
  // "write after end", when they read more than one file at a time
  it('packs a directory with several hard links into a stream', async () => {
    for (let i = 0; i < 10; i++) {
      const target = join(root, `stream-${i}`)
      mkdirSync(target)
      await pipeline(
        Readable.from(packArchive({ cwd: join(root, 'source'), gzip: true }, ['node_modules'])),
        extract({ cwd: target })
      )
      expectRestored(target)
    }
  }, 10000)

  it('packs a directory with several hard links into a file', async () => {
    for (let i = 0; i < 10; i++) {
      const file = join(root, `archive-${i}.tar`)
      const target = join(root, `file-${i}`)
      mkdirSync(target)
      await packArchive({ file, cwd: join(root, 'source'), portable: true, noMtime: true }, ['node_modules'])
      await extract({ file, cwd: target })
      expectRestored(target)
    }
  }, 10000)

  it('packs files in full whose id may be rounded, as on Windows', async () => {
    // a 64-bit file id above 2^53 comes out of Node rounded, so two link groups can share it
    const lstat = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation(((path: string, callback: (err: Error | null, stat?: fs.Stats) => void) =>
      lstat(path, (err, stat) => {
        if (stat && /^(file|link)-[01]\.js$/.test(basename(path))) {
          Object.defineProperty(stat, 'ino', { value: 2 ** 60 })
        }
        callback(err, stat)
      })) as typeof fs.lstat)

    const target = join(root, 'rounded')
    mkdirSync(target)
    await pipeline(
      Readable.from(packArchive({ cwd: join(root, 'source') }, ['node_modules'])),
      extract({ cwd: target })
    )
    for (let i = 0; i < 5; i++) {
      for (const path of [`file-${i}.js`, `link-${i}.js`, join('sub', `link-${i}.js`)]) {
        expect(readFileSync(join(target, 'node_modules', path), 'utf8')).toBe(`content ${i}`)
      }
    }
    expect(statSync(join(target, 'node_modules', 'file-1.js')).nlink).toBe(1)
  })

  // node-tar ends the archive a second time ("write after end", thrown in an fs callback)
  // when the last file it packs is empty and its other links are not in the archive yet
  describe('an empty file with more than one link, packed last', () => {
    let errors: Error[]
    const onError = (error: Error) => errors.push(error)

    beforeEach(() => {
      errors = []
      process.prependListener('uncaughtException', onError)
    })

    afterEach(() => {
      process.removeListener('uncaughtException', onError)
    })

    async function packEmpty(cwd: string, file: string): Promise<string> {
      const target = mkdtempSync(join(root, 'empty-'))
      await pipeline(Readable.from(packArchive({ cwd }, [file])), extract({ cwd: target }))
      // the second end comes in a later fs callback
      await new Promise((resolve) => setTimeout(resolve, 50))
      return target
    }

    it('packs it when its other link is outside the packed directory, as in a pnpm node_modules', async () => {
      mkdirSync(join(root, 'store'), { recursive: true })
      mkdirSync(join(root, 'project', 'node_modules'), { recursive: true })
      writeFileSync(join(root, 'store', 'empty.js'), '')
      linkSync(join(root, 'store', 'empty.js'), join(root, 'project', 'node_modules', 'empty.js'))

      for (let i = 0; i < 5; i++) {
        const target = await packEmpty(join(root, 'project'), 'node_modules')
        expect(readFileSync(join(target, 'node_modules', 'empty.js'), 'utf8')).toBe('')
      }
      expect(errors).toEqual([])
    })

    it('packs it when its id may be rounded, as on Windows', async () => {
      mkdirSync(join(root, 'empty-links'), { recursive: true })
      writeFileSync(join(root, 'empty-links', 'empty.js'), '')
      linkSync(join(root, 'empty-links', 'empty.js'), join(root, 'empty-links', 'linked.js'))
      const lstat = fs.lstat
      vi.spyOn(fs, 'lstat').mockImplementation(((
        path: string,
        callback: (err: Error | null, stat?: fs.Stats) => void
      ) =>
        lstat(path, (err, stat) => {
          if (stat && stat.isFile()) {
            Object.defineProperty(stat, 'ino', { value: 2 ** 60 })
          }
          callback(err, stat)
        })) as typeof fs.lstat)

      for (let i = 0; i < 5; i++) {
        const target = await packEmpty(root, 'empty-links')
        expect(readFileSync(join(target, 'empty-links', 'empty.js'), 'utf8')).toBe('')
        expect(readFileSync(join(target, 'empty-links', 'linked.js'), 'utf8')).toBe('')
      }
      expect(errors).toEqual([])
    })
  })
})
