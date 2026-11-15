import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { statBeneath } from './stat-beneath'

describe('what a path of a root is, without following a link', () => {
  let base: string
  let root: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hammerkit-stat-beneath-'))
    root = join(base, 'run')
    mkdirSync(join(root, 'x', 'etc'), { recursive: true })
    writeFileSync(join(root, 'x', 'etc', 'config'), 'the run')
    mkdirSync(join(base, 'server', 'etc'), { recursive: true })
    writeFileSync(join(base, 'server', 'etc', 'config'), 'the server')
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('is the folder or file at the path', async () => {
    for (const path of [root, join(root, 'x', 'etc'), join(root, 'x', 'etc', 'config')]) {
      const expected = statSync(path, { bigint: true })
      const found = await statBeneath(root, path)
      expect([found.dev, found.ino], path).toEqual([expected.dev, expected.ino])
    }
  })

  it('refuses a path through a link, wherever on the way, and outside the root', async () => {
    if (process.platform === 'win32') {
      return
    }
    rmSync(join(root, 'x'), { recursive: true })
    // a folder above the path a link to one of the server with the same names below it
    symlinkSync(join(base, 'server'), join(root, 'x'))
    await expect(statBeneath(root, join(root, 'x', 'etc'))).rejects.toThrow(/symbolic link/)
    await expect(statBeneath(root, join(root, 'x', 'etc', 'config'))).rejects.toThrow(/symbolic link/)
    await expect(statBeneath(root, join(root, 'x'))).rejects.toThrow(/symbolic link/)
    await expect(statBeneath(root, join(base, 'server'))).rejects.toThrow(/outside of/)
  })
})
