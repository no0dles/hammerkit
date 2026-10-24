import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Parser } from 'tar'
import { packSource } from './ensure-persistent-data'

// the paths of the entries of an archive
async function listEntries(archive: NodeJS.ReadableStream): Promise<string[]> {
  const paths: string[] = []
  const parser = new Parser({
    onReadEntry: (entry) => {
      paths.push(entry.type === 'Link' ? `${entry.path} -> ${entry.linkpath}` : entry.path)
      entry.resume()
    },
  })
  await new Promise<void>((resolve, reject) => {
    parser.on('end', resolve)
    parser.on('error', reject)
    archive.pipe(parser)
  })
  return paths
}

describe('packSource', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-pack-source-'))
    mkdirSync(join(root, 'api', 'src'), { recursive: true })
    writeFileSync(join(root, 'api', 'package.json'), '{}')
    writeFileSync(join(root, 'api', 'src', 'index.ts'), '')
    linkSync(join(root, 'api', 'src', 'index.ts'), join(root, 'api', 'src', 'linked.ts'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('puts a file where its mount reads it in the claim', async () => {
    const archive = packSource({
      localPath: join(root, 'api', 'package.json'),
      subPath: 'package.json-0123456789ab',
      matcher: () => true,
    })
    expect(await listEntries(archive)).toEqual(['package.json-0123456789ab'])
  })

  it('puts a directory and what is in it where its mount reads it in the claim', async () => {
    const archive = packSource({
      localPath: join(root, 'api', 'src'),
      subPath: 'src-0123456789ab',
      matcher: () => true,
    })
    const entries = await listEntries(archive)
    expect(entries[0]).toBe('src-0123456789ab/')
    // one of two hard-linked files links to the other at its place in the claim
    expect(entries.slice(1).sort()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^src-0123456789ab\/(index|linked)\.ts -> src-0123456789ab\/(index|linked)\.ts$/),
      ])
    )
    expect(entries.slice(1).every((entry) => entry.startsWith('src-0123456789ab/'))).toBe(true)
    expect(entries).toHaveLength(3)
  })

  it('packs a directory with several hard links', async () => {
    // node-tar 7.5.14 and later hang on this with more than one file read at a time
    // (see packOptions)
    mkdirSync(join(root, 'linked', 'node_modules'), { recursive: true })
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, 'linked', 'node_modules', `file-${i}.js`), `${i}`)
      linkSync(
        join(root, 'linked', 'node_modules', `file-${i}.js`),
        join(root, 'linked', 'node_modules', `link-${i}.js`)
      )
    }
    for (let i = 0; i < 10; i++) {
      const archive = packSource({
        localPath: join(root, 'linked', 'node_modules'),
        subPath: 'node_modules-0123456789ab',
        matcher: () => true,
      })
      expect(await listEntries(archive)).toHaveLength(11)
    }
  }, 10000)
})
