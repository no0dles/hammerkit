import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
      writeFileSync(join(root, 'source', 'node_modules', `file-${i}.js`), `${i}`)
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

  function expectLinked(dir: string): void {
    for (let i = 0; i < 5; i++) {
      const file = statSync(join(dir, 'node_modules', `file-${i}.js`))
      expect(file.nlink).toBe(3)
      expect(statSync(join(dir, 'node_modules', `link-${i}.js`)).ino).toBe(file.ino)
      expect(statSync(join(dir, 'node_modules', 'sub', `link-${i}.js`)).ino).toBe(file.ino)
    }
  }

  // node-tar 7.5.14 and later hang on a directory with several hard links, or fail with
  // "write after end", when they read more than one file at a time
  it('packs a directory with several hard links into a stream, keeping them linked', async () => {
    for (let i = 0; i < 10; i++) {
      const target = join(root, `stream-${i}`)
      mkdirSync(target)
      await pipeline(
        Readable.from(packArchive({ cwd: join(root, 'source'), gzip: true }, ['node_modules'])),
        extract({ cwd: target })
      )
      expectLinked(target)
    }
  }, 10000)

  it('packs a directory with several hard links into a file, keeping them linked', async () => {
    for (let i = 0; i < 10; i++) {
      const file = join(root, `archive-${i}.tar`)
      const target = join(root, `file-${i}`)
      mkdirSync(target)
      await packArchive({ file, cwd: join(root, 'source'), portable: true, noMtime: true }, ['node_modules'])
      await extract({ file, cwd: target })
      expectLinked(target)
    }
  }, 10000)
})
