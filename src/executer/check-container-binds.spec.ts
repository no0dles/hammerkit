import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { assertContainerBinds } from './check-container-binds'

// a container whose `ls -di` prints `output` and exits with `exitCode`
function container(output: string, exitCode = 0): any {
  const exec = vi.fn(async () => ({
    start: async () => new PassThrough(),
    inspect: async () => ({ ExitCode: exitCode }),
  }))
  return {
    exec,
    modem: {
      demuxStream: (stream: PassThrough, stdout: PassThrough) => {
        stdout.write(output)
        setImmediate(() => stream.emit('end'))
      },
    },
  }
}

describe('the binds of a started container', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-check-binds-'))
    mkdirSync(join(root, 'src'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const item: any = { name: 'build', data: { type: 'container-task', src: [], mounts: [], generates: [] } }
  const hosted = (): any => ({ hosted: {}, cwd: root })
  const binds = () => [
    { localPath: join(root, 'src'), containerPath: '/work/src' },
    // a volume is no path of the host
    { localPath: 'hammerkit-dist', containerPath: '/work/dist' },
  ]

  it('takes the folder of the run, by its inode', async () => {
    const inode = statSync(join(root, 'src'), { bigint: true }).ino
    const seen = container(`${inode} /work/src\n`)
    await assertContainerBinds(item, hosted(), seen, binds())
    expect(seen.exec).toHaveBeenCalledTimes(1)
    expect(seen.exec).toHaveBeenCalledWith(expect.objectContaining({ Cmd: ['ls', '-di', '--', '/work/src'] }))
  })

  it('refuses another folder, and an image it can not check', async () => {
    await expect(assertContainerBinds(item, hosted(), container('1 /work/src\n'), binds())).rejects.toThrow(
      'build: the container does not bind the files of the run at /work/src'
    )
    await expect(assertContainerBinds(item, hosted(), container('sh: ls: not found\n', 127), binds())).rejects.toThrow(
      'build: can not check what the container binds at /work/src: a server needs ls in the image'
    )
  })

  it('checks nothing off a server', async () => {
    const seen = container('1 /work/src\n')
    await assertContainerBinds(item, { cwd: root } as any, seen, binds())
    expect(seen.exec).not.toHaveBeenCalled()
  })
})
