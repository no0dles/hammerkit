import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertWithinRoot, findRootEscape } from './within-root'
import { assertItemPathsWithinRoot } from '../planner/utils/assert-item-paths'

describe('paths within the root of a run', () => {
  let base: string
  let root: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hammerkit-within-root-'))
    root = join(base, 'checkout')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), '')
    mkdirSync(join(base, 'secrets'))
    writeFileSync(join(base, 'secrets', 'token'), 'server token')
    // a junction on Windows, which needs no privilege and lstat reports as a link
    symlinkSync(join(base, 'secrets'), join(root, 'link'), 'junction')
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('takes paths inside the root, also ones that do not exist yet', async () => {
    expect(await findRootEscape(root, root)).toBeNull()
    expect(await findRootEscape(root, join(root, 'src'))).toBeNull()
    expect(await findRootEscape(root, join(root, 'src', 'index.ts'))).toBeNull()
    expect(await findRootEscape(root, join(root, 'out', 'result.txt'))).toBeNull()
    expect(await findRootEscape(root, 'src')).toBeNull()
  })

  it('refuses paths that lead out of the root', async () => {
    expect(await findRootEscape(root, join(root, '..', 'secrets'))).toBe('is outside of the source')
    expect(await findRootEscape(root, join(root, 'src', '..', '..'))).toBe('is outside of the source')
    expect(await findRootEscape(root, join(base, 'secrets', 'token'))).toBe('is outside of the source')
    await expect(assertWithinRoot(root, join(base, 'secrets'), 'task a: src ../secrets')).rejects.toThrow(
      'task a: src ../secrets is outside of the source'
    )
  })

  it('refuses paths through a symbolic link of the root, wherever it points', async () => {
    expect(await findRootEscape(root, join(root, 'link'))).toBe('goes through the symbolic link link')
    expect(await findRootEscape(root, join(root, 'link', 'token'))).toBe('goes through the symbolic link link')
    symlinkSync(join(root, 'src'), join(root, 'src', 'self'), 'junction')
    expect(await findRootEscape(root, join(root, 'src', 'self', 'index.ts'))).toBe(
      'goes through the symbolic link src/self'
    )
  })

  it('checks the sources, outputs and mounts of an item', async () => {
    const item = (data: object): any => ({
      name: 'build',
      data: { type: 'container-task', src: [], generates: [], mounts: [], ...data },
    })
    const source = (path: string, inherited: object | null = null) => ({
      absolutePath: path,
      source: path,
      inherited,
    })
    await expect(
      assertItemPathsWithinRoot(
        item({
          src: [source(join(root, 'src'))],
          generates: [{ path: join(root, 'out'), inherited: null }],
          mounts: [{ localPath: join(root, 'cache') }],
        }),
        root
      )
    ).resolves.toBeUndefined()
    await expect(assertItemPathsWithinRoot(item({ src: [source(join(root, 'link', 'token'))] }), root)).rejects.toThrow(
      `build: src ${join(root, 'link', 'token')} goes through the symbolic link link`
    )
    await expect(
      assertItemPathsWithinRoot(item({ generates: [{ path: join(root, 'link'), inherited: null }] }), root)
    ).rejects.toThrow('goes through the symbolic link link')
    await expect(
      assertItemPathsWithinRoot(item({ mounts: [{ localPath: join(base, 'secrets') }] }), root)
    ).rejects.toThrow('is outside of the source')
    // a dependency's source is checked with the dependency
    await expect(
      assertItemPathsWithinRoot(item({ src: [source(join(base, 'secrets'), { name: 'dep' })] }), root)
    ).resolves.toBeUndefined()
  })
})
