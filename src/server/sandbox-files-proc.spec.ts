import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HostSandboxFiles, SandboxFileError } from './sandbox-files'

// a server whose /proc does not name the files it opened (a container without it mounted)
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    readlink: (path: string, ...rest: unknown[]) =>
      String(path).startsWith('/proc/self/fd/')
        ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        : (actual.readlink as (...args: unknown[]) => Promise<string>)(path, ...rest),
  }
})

describe('sandbox files without /proc', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-sandbox-proc-'))
    writeFileSync(join(root, 'README.md'), 'hello\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads nothing on Linux rather than check the path of what it opened', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const files = new HostSandboxFiles(root, {} as any, {})
    const error = await files.read('README.md', {}).catch((e) => e)
    expect(error).toBeInstanceOf(SandboxFileError)
    expect(error).toMatchObject({ status: 503 })
    expect(error.message).toMatch(/can not tell which file it opened/)
  })
})
