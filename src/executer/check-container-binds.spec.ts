import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { assertContainerBinds, refuseServerToolsPaths, refuseUncheckableBinds } from './check-container-binds'

// a container whose busybox `stat` prints `output` and exits with `exitCode`
function container(output: string, exitCode = 0): any {
  const exec = vi.fn(async () => ({
    start: async () => new PassThrough(),
    inspect: async () => ({ ExitCode: exitCode }),
  }))
  return {
    exec,
    modem: {
      demuxStream: (stream: PassThrough, stdout: PassThrough, stderr: PassThrough) => {
        const target = exitCode === 0 ? stdout : stderr
        target.write(output)
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
  const identity = () => {
    const stats = statSync(join(root, 'src'), { bigint: true })
    return `${stats.dev} ${stats.ino}`
  }

  it('takes the folder of the run, by its device and inode, read by the server’s busybox', async () => {
    const seen = container(`${identity()}\n`)
    await assertContainerBinds(item, hosted(), seen, binds())
    expect(seen.exec).toHaveBeenCalledTimes(1)
    expect(seen.exec).toHaveBeenCalledWith(
      expect.objectContaining({ Cmd: ['/.hammerkit/busybox', 'stat', '-c', '%d %i', '--', '/work/src'], User: '0' })
    )
  })

  it('refuses another folder, and a container it can not ask', async () => {
    const [dev, ino] = identity().split(' ')
    for (const other of [`${dev} ${BigInt(ino) + 1n}`, `${BigInt(dev) + 1n} ${ino}`]) {
      await expect(assertContainerBinds(item, hosted(), container(`${other}\n`), binds())).rejects.toThrow(
        'build: the container does not bind the files of the run at /work/src'
      )
    }
    await expect(assertContainerBinds(item, hosted(), container('stat: can not stat', 1), binds())).rejects.toThrow(
      'build: can not check what the container binds at /work/src: stat: can not stat'
    )
  })

  it('checks nothing off a server', async () => {
    const seen = container('1 1\n')
    await assertContainerBinds(item, { cwd: root } as any, seen, binds())
    expect(seen.exec).not.toHaveBeenCalled()
  })

  it('refuses a path of an item where the server keeps its tools in a container', () => {
    const service = (containerPath: string): any => ({
      name: 'db',
      data: {
        type: 'container-service',
        src: [],
        volumes: [],
        mounts: [{ localPath: join(root, 'src'), containerPath }],
      },
    })
    for (const path of ['/', '/.hammerkit', '/.hammerkit/run/go']) {
      expect(() => refuseServerToolsPaths(service(path), hosted()), path).toThrow(
        `db: ${path} is where the server keeps its tools in a container, nothing can be there`
      )
    }
    expect(() => refuseServerToolsPaths(service('/.hammerkit-other'), hosted())).not.toThrow()
    expect(() => refuseServerToolsPaths(service('/'), { cwd: root } as any)).not.toThrow()
  })

  it('refuses a task that adds capabilities and binds files of the run, on a server only', () => {
    const task = (capAdd: string[], src: string[], generates: any[] = []): any => ({
      name: 'image',
      data: {
        type: 'container-task',
        capAdd,
        mounts: [],
        generates,
        src: src.map((absolutePath) => ({ absolutePath })),
      },
    })
    expect(() => refuseUncheckableBinds(task(['SYS_ADMIN'], [join(root, 'src')]), hosted())).toThrow(
      `image: adds capabilities and binds ${join(
        root,
        'src'
      )}; on a server's docker host a task that adds capabilities can not bind files of the run`
    )
    // a cache volume is no file of the run
    const cache = [{ isFile: false, volumeName: 'hammerkit-cache', path: '/cache' }]
    expect(() => refuseUncheckableBinds(task(['SYS_ADMIN'], [], cache), hosted())).not.toThrow()
    expect(() => refuseUncheckableBinds(task([], [join(root, 'src')]), hosted())).not.toThrow()
    expect(() => refuseUncheckableBinds(task(['SYS_ADMIN'], [join(root, 'src')]), { cwd: root } as any)).not.toThrow()
  })
})
