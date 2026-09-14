import { getContainerBinds } from './get-container-binds'

describe('getContainerBinds', () => {
  it('collects mounts, src, non-file generates and file generates', () => {
    const item = {
      data: {
        mounts: [{ localPath: '/host/mnt', containerPath: '/mnt' }],
        src: [{ absolutePath: '/host/src' }],
        generates: [
          { volumeName: 'vol1', path: '/gen/vol1', isFile: false },
          { volumeName: 'vol2', path: '/gen/file.txt', isFile: true },
        ],
      },
    } as any

    expect(getContainerBinds(item)).toEqual([
      { localPath: '/host/mnt', containerPath: '/mnt' },
      { localPath: '/host/src', containerPath: '/host/src' },
      { localPath: 'vol1', containerPath: '/gen/vol1' },
      { localPath: '/gen/file.txt', containerPath: '/gen/file.txt' },
    ])
  })

  it('deduplicates by containerPath, keeping the first occurrence', () => {
    const item = {
      data: {
        mounts: [{ localPath: '/host/mnt', containerPath: '/dup' }],
        src: [{ absolutePath: '/host/src' }],
        generates: [{ volumeName: 'vol1', path: '/dup', isFile: false }],
      },
    } as any

    expect(getContainerBinds(item)).toEqual([
      { localPath: '/host/mnt', containerPath: '/dup' },
      { localPath: '/host/src', containerPath: '/host/src' },
    ])
  })

  it('returns an empty array for an empty item', () => {
    const item = { data: { mounts: [], src: [], generates: [] } } as any
    expect(getContainerBinds(item)).toEqual([])
  })
})
