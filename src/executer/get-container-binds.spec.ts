import { join } from 'path'
import { getContainerBinds } from './get-container-binds'

function task(src: string[], extra: { mounts?: any[]; generates?: any[] } = {}) {
  return {
    data: {
      mounts: extra.mounts ?? [],
      src: src.map((absolutePath) => ({ absolutePath })),
      generates: extra.generates ?? [],
    },
  } as any
}

describe('getContainerBinds', () => {
  const root = join('/', 'project')

  it('binds every source at its own path', () => {
    const binds = getContainerBinds(task([join(root, 'src'), join(root, 'package.json')]))
    expect(binds).toEqual([
      { localPath: join(root, 'src'), containerPath: join(root, 'src') },
      { localPath: join(root, 'package.json'), containerPath: join(root, 'package.json') },
    ])
  })

  // A source inside another source (a dependency's `Greet/Greet.csproj` under the
  // task's own `Greet`) is already visible through the outer bind. Binding it
  // again nests one bind mount in another, which Docker Desktop then refuses to
  // let the host delete while the paused container exists.
  it('skips a source that lies inside another source', () => {
    const binds = getContainerBinds(
      task([join(root, 'Greet', 'Greet.csproj'), join(root, 'Greet'), join(root, 'src', 'main'), join(root, 'src')])
    )
    expect(binds.map((b) => b.containerPath)).toEqual([join(root, 'Greet'), join(root, 'src')])
  })

  it('keeps sources that only share a name prefix', () => {
    const binds = getContainerBinds(task([join(root, 'src'), join(root, 'src-gen')]))
    expect(binds.map((b) => b.containerPath)).toEqual([join(root, 'src'), join(root, 'src-gen')])
  })

  it('keeps mounts and generated volumes inside a source', () => {
    const binds = getContainerBinds(
      task([join(root, 'Greet')], {
        mounts: [{ localPath: join(root, '.cache'), containerPath: join(root, 'Greet', 'cache') }],
        generates: [{ path: join(root, 'Greet', 'obj'), volumeName: 'hammerkit-obj', isFile: false }],
      })
    )
    expect(binds).toEqual([
      { localPath: join(root, '.cache'), containerPath: join(root, 'Greet', 'cache') },
      { localPath: join(root, 'Greet'), containerPath: join(root, 'Greet') },
      { localPath: 'hammerkit-obj', containerPath: join(root, 'Greet', 'obj') },
    ])
  })
})
