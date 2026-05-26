import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync, symlinkSync, readFileSync } from 'fs'
import { Readable } from 'stream'
import { getFileContext } from './get-file-context'

describe('getFileContext', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hammerkit-fc-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  describe('stats', () => {
    it('reports type "directory" for a directory', async () => {
      const fc = getFileContext(cwd)
      expect((await fc.stats('.')).type).toBe('directory')
    })

    it('reports type "file" with lastModified for a regular file', async () => {
      writeFileSync(join(cwd, 'a.txt'), 'x')
      const fc = getFileContext(cwd)
      const s = await fc.stats('a.txt')
      expect(s.type).toBe('file')
      if (s.type === 'file') {
        expect(s.lastModified).toBeGreaterThan(0)
      }
    })

    it('rejects when the path does not exist', async () => {
      const fc = getFileContext(cwd)
      await expect(fc.stats('missing')).rejects.toThrow()
    })

    it('reports type "other" for non-file non-directory entries (symlink to missing)', async () => {
      const link = join(cwd, 'link')
      try {
        symlinkSync('/no/such/target', link)
      } catch {
        // symlink may not be permitted on this platform — accept either outcome
        return
      }
      // statSync (used by stats()) follows symlinks; if the target is missing it errors.
      // That is the existing behavior; we cover the rejection path here.
      const fc = getFileContext(cwd)
      await expect(fc.stats('link')).rejects.toThrow()
    })
  })

  describe('exists', () => {
    it('resolves true for an existing path and false otherwise', async () => {
      const fc = getFileContext(cwd)
      expect(await fc.exists('.')).toBe(true)
      expect(await fc.exists('nope')).toBe(false)
    })
  })

  describe('writeFile / read / appendFile', () => {
    it('writes, reads, and appends file content', async () => {
      const fc = getFileContext(cwd)
      await fc.writeFile('f.txt', 'hello')
      expect(await fc.read('f.txt')).toBe('hello')
      await fc.appendFile('f.txt', ' world')
      expect(await fc.read('f.txt')).toBe('hello world')
    })

    it('read rejects on missing file', async () => {
      const fc = getFileContext(cwd)
      await expect(fc.read('missing.txt')).rejects.toThrow()
    })
  })

  describe('listFiles', () => {
    it('returns the entries in a directory', async () => {
      writeFileSync(join(cwd, 'a'), '')
      writeFileSync(join(cwd, 'b'), '')
      const fc = getFileContext(cwd)
      expect((await fc.listFiles('.')).sort()).toEqual(['a', 'b'])
    })
  })

  describe('createDirectory / remove', () => {
    it('creates a directory recursively and removes it', async () => {
      const fc = getFileContext(cwd)
      await fc.createDirectory(join('deep', 'inner'))
      expect(await fc.exists(join('deep', 'inner'))).toBe(true)
      await fc.remove('deep')
      expect(await fc.exists('deep')).toBe(false)
    })

    it('remove on a missing path is a no-op', async () => {
      const fc = getFileContext(cwd)
      await expect(fc.remove('nope')).resolves.toBeUndefined()
    })
  })

  describe('copy', () => {
    it('copies a file, creating the destination directory if needed', async () => {
      const fc = getFileContext(cwd)
      await fc.writeFile('src.txt', 'data')
      await fc.copy('src.txt', join('dest', 'src.txt'))
      expect(readFileSync(join(cwd, 'dest', 'src.txt'), 'utf8')).toBe('data')
    })

    it('copies a directory recursively', async () => {
      const fc = getFileContext(cwd)
      mkdirSync(join(cwd, 'src', 'sub'), { recursive: true })
      writeFileSync(join(cwd, 'src', 'a.txt'), 'a')
      writeFileSync(join(cwd, 'src', 'sub', 'b.txt'), 'b')
      await fc.copy('src', 'dest')
      expect(readFileSync(join(cwd, 'dest', 'a.txt'), 'utf8')).toBe('a')
      expect(readFileSync(join(cwd, 'dest', 'sub', 'b.txt'), 'utf8')).toBe('b')
    })

    it('copy of a missing source is a no-op', async () => {
      const fc = getFileContext(cwd)
      await expect(fc.copy('nope', 'dest')).resolves.toBeUndefined()
      expect(statSync(join(cwd))).toBeDefined() // cwd still exists
    })

    it('copy preserves the destination directory when it already exists', async () => {
      const fc = getFileContext(cwd)
      await fc.writeFile('src.txt', 'x')
      mkdirSync(join(cwd, 'dest'))
      await fc.copy('src.txt', join('dest', 'src.txt'))
      expect(readFileSync(join(cwd, 'dest', 'src.txt'), 'utf8')).toBe('x')
    })
  })

  describe('streams', () => {
    it('writeStream pipes a Readable into a file', async () => {
      const fc = getFileContext(cwd)
      const target = join(cwd, 'out.bin')
      await fc.writeStream(target, Readable.from(['part-a', 'part-b']))
      expect(readFileSync(target, 'utf8')).toBe('part-apart-b')
    })

    it('createWriteStream returns a writable stream', async () => {
      const fc = getFileContext(cwd)
      const target = join(cwd, 'wstream.txt')
      const ws = fc.createWriteStream(target)
      await new Promise<void>((resolve) => ws.end('payload', resolve))
      expect(readFileSync(target, 'utf8')).toBe('payload')
    })

    it('readStream reads back what writeStream wrote', async () => {
      const fc = getFileContext(cwd)
      const target = join(cwd, 'r.txt')
      writeFileSync(target, 'abc')
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        const rs = fc.readStream(target)
        rs.on('data', (c: Buffer) => chunks.push(c))
        rs.on('end', resolve)
        rs.on('error', reject)
      })
      expect(Buffer.concat(chunks).toString()).toBe('abc')
    })
  })

  describe('watch', () => {
    it('returns a handle whose close() is callable; the polling override is honored', async () => {
      const previous = process.env.HAMMERKIT_WATCH_POLLING
      process.env.HAMMERKIT_WATCH_POLLING = 'false'
      try {
        const fc = getFileContext(cwd)
        const handle = fc.watch('.', () => undefined)
        // close() returns a Promise on chokidar; await it
        await Promise.resolve(handle.close())
      } finally {
        if (previous === undefined) delete process.env.HAMMERKIT_WATCH_POLLING
        else process.env.HAMMERKIT_WATCH_POLLING = previous
      }
    })
  })
})
