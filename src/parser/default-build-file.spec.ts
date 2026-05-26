import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../executer/environment-mock'
import { getBuildFilename } from './default-build-file'

describe('getBuildFilename', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hammerkit-getbuildfilename-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the path itself when it points at an existing file', async () => {
    const file = join(dir, '.hammerkit.yaml')
    writeFileSync(file, 'tasks: {}\n')
    expect(await getBuildFilename(file, environmentMock(dir))).toBe(file)
  })

  it('falls back to <dir>/.hammerkit.yaml when the directory has no build file', async () => {
    expect(await getBuildFilename(dir, environmentMock(dir))).toBe(join(dir, '.hammerkit.yaml'))
  })

  it('picks an existing build file in the directory', async () => {
    writeFileSync(join(dir, 'build.yaml'), 'tasks: {}\n')
    expect(await getBuildFilename(dir, environmentMock(dir))).toBe(join(dir, 'build.yaml'))
  })

  it('prefers .hammerkit.yaml when multiple build files coexist and warns', async () => {
    writeFileSync(join(dir, '.hammerkit.yaml'), 'tasks: {}\n')
    writeFileSync(join(dir, 'build.yaml'), 'tasks: {}\n')

    const env = environmentMock(dir)
    const warn = jest.spyOn(env.console, 'warn').mockImplementation(() => undefined)
    const result = await getBuildFilename(dir, env)
    expect(result).toBe(join(dir, '.hammerkit.yaml'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('multiple hammerkit files'))
  })

  it('handles a missing path by returning <path>/.hammerkit.yaml', async () => {
    const missing = join(dir, 'does-not-exist')
    expect(await getBuildFilename(missing, environmentMock(dir))).toBe(join(missing, '.hammerkit.yaml'))
  })

  it('ignores a path that exists but is neither a file nor a build dir match', async () => {
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    // empty directory exists but has no build files; falls back to default
    expect(await getBuildFilename(sub, environmentMock(dir))).toBe(join(sub, '.hammerkit.yaml'))
  })
})
