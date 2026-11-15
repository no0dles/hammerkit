import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { createServerTools } from '../docker/server-tools'
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

  const item: any = { name: 'build', data: { type: 'container-task', src: [], mounts: [], generates: [], secrets: [] } }
  const hosted = (): any => ({ hosted: {}, cwd: root })
  const binds = () => [
    { localPath: join(root, 'src'), containerPath: '/work/src' },
    // a volume is no path of the host
    { localPath: 'hammerkit-dist', containerPath: '/work/dist' },
  ]
  const tools = createServerTools('/var/lib/hammerkit/tools/busybox')
  const identity = () => {
    const stats = statSync(join(root, 'src'), { bigint: true })
    return `${stats.dev} ${stats.ino}`
  }

  it('takes the folder of the run, by its device and inode, read by the server’s busybox', async () => {
    const seen = container(`${identity()}\n`)
    await assertContainerBinds(item, hosted(), seen, binds(), tools)
    expect(seen.exec).toHaveBeenCalledTimes(1)
    expect(seen.exec).toHaveBeenCalledWith(
      expect.objectContaining({ Cmd: [`${tools.folder}/busybox`, 'stat', '-c', '%d %i', '--', '/work/src'], User: '0' })
    )
  })

  it('refuses another folder, and a container it can not ask', async () => {
    const [dev, ino] = identity().split(' ')
    for (const other of [`${dev} ${BigInt(ino) + 1n}`, `${BigInt(dev) + 1n} ${ino}`]) {
      await expect(assertContainerBinds(item, hosted(), container(`${other}\n`), binds(), tools)).rejects.toThrow(
        'build: the container does not bind the files of the run at /work/src'
      )
    }
    await expect(
      assertContainerBinds(item, hosted(), container('stat: can not stat', 1), binds(), tools)
    ).rejects.toThrow('build: can not check what the container binds at /work/src: stat: can not stat')
  })

  it('keeps the folder of the tools out of what it reports', async () => {
    const seen = container(`exec ${tools.folder}/busybox: no such file`, 126)
    const error = await assertContainerBinds(item, hosted(), seen, binds(), tools).catch((e) => e as Error)
    expect(error?.message).toContain('/.hammerkit-…/busybox: no such file')
    expect(error?.message).not.toContain(tools.folder)
  })

  it('makes up a folder for the tools of each container', () => {
    const other = createServerTools('/var/lib/hammerkit/tools/busybox')
    expect(tools.folder).toMatch(/^\/\.hammerkit-[0-9a-f]{32}$/)
    expect(other.folder).not.toEqual(tools.folder)
  })

  it('checks nothing off a server', async () => {
    const seen = container('1 1\n')
    await assertContainerBinds(item, { cwd: root } as any, seen, binds(), tools)
    expect(seen.exec).not.toHaveBeenCalled()
  })

  it('refuses a path of an item where the server keeps its tools in a container', () => {
    const service = (containerPath: string, secrets: any[] = []): any => ({
      name: 'db',
      data: {
        type: 'container-service',
        src: [],
        volumes: [],
        secrets,
        mounts: [{ localPath: join(root, 'src'), containerPath }],
      },
    })
    for (const path of ['/', '/.hammerkit', '/.hammerkit/run/go', '/.hammerkit-other', `${tools.folder}/run/go`]) {
      expect(() => refuseServerToolsPaths(service(path), hosted()), path).toThrow(
        `db: ${path} is where the server keeps its tools in a container, nothing can be there`
      )
    }
    // a secret file too
    const secret = {
      source: { type: 'file', path: '/etc/token' },
      target: { type: 'file', path: `${tools.folder}/run/go` },
    }
    expect(() => refuseServerToolsPaths(service('/data', [secret]), hosted())).toThrow(
      `db: ${tools.folder}/run/go is where the server keeps its tools in a container, nothing can be there`
    )
    const env = { source: { type: 'file', path: '/etc/token' }, target: { type: 'env', name: 'TOKEN' } }
    expect(() => refuseServerToolsPaths(service('/data', [env]), hosted())).not.toThrow()
    expect(() => refuseServerToolsPaths(service('/.hammerkitten'), hosted())).not.toThrow()
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
