import Dockerode from 'dockerode'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { assertContainerBinds } from '../../executer/check-container-binds'

// A container of a server run binds paths of the run's files. What the engine bound is
// compared with the files of the run once the container started, whatever the paths
// lead to by the time it is checked.
describe('container binds of a server run (docker)', () => {
  const docker = new Dockerode()
  let base: string
  let root: string
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'hammerkit-container-binds-')))
    root = join(base, 'run')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'the source')
    mkdirSync(join(base, 'other'))
    writeFileSync(join(base, 'other', 'index.ts'), 'not the source')
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const item = (path: string): any => ({
    name: 'build',
    data: {
      type: 'container-task',
      src: [{ absolutePath: path, source: 'src', inherited: null, isFile: false, matcher: () => true }],
      mounts: [],
      generates: [],
    },
  })
  const environment = (): any => ({ hosted: {}, cwd: root })

  async function withContainer(bind: string, fn: (container: Dockerode.Container) => Promise<void>) {
    const container = await docker.createContainer({
      Image: 'alpine:3.21',
      Entrypoint: ['sh'],
      Cmd: ['-c', 'sleep 60'],
      HostConfig: { Binds: [`${bind}:/work/src`], AutoRemove: true },
    })
    try {
      await container.start()
      await fn(container)
    } finally {
      await container.remove({ force: true }).catch(() => undefined)
    }
  }

  it(
    'takes a container that binds the files of the run',
    requiresLinuxContainers(async () => {
      await withContainer(join(root, 'src'), async (container) => {
        await assertContainerBinds(item(join(root, 'src')), environment(), container, [
          { localPath: join(root, 'src'), containerPath: '/work/src' },
        ])
      })
    }),
    60_000
  )

  it(
    'refuses a container whose bind was a link as it started, though the link is gone',
    requiresLinuxContainers(async () => {
      const src = join(root, 'src')
      renameSync(src, join(root, 'src-real'))
      symlinkSync(join(base, 'other'), src)
      await withContainer(src, async (container) => {
        // what a task of the run puts back before the check
        rmSync(src)
        renameSync(join(root, 'src-real'), src)
        await expect(
          assertContainerBinds(item(src), environment(), container, [{ localPath: src, containerPath: '/work/src' }])
        ).rejects.toThrow('build: the container does not bind the files of the run at /work/src')
      })
    }),
    60_000
  )
})
