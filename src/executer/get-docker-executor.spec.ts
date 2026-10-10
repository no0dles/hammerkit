import { existsVolume, ensureVolumeExists, removeVolume, recreateVolume } from './get-docker-executor'
import type { Mock } from 'vitest'

function makeDocker(inspect?: Mock, remove?: Mock) {
  return {
    getVolume: vi.fn(() => ({ inspect, remove })),
    createVolume: vi.fn(),
  } as any
}

describe('existsVolume', () => {
  it('resolves with the inspect info when the volume exists', async () => {
    const info = { Name: 'vol' }
    const docker = makeDocker(vi.fn().mockResolvedValue(info))
    await expect(existsVolume(docker, 'vol')).resolves.toBe(info)
    expect(docker.getVolume).toHaveBeenCalledWith('vol')
  })

  it('resolves false when inspect rejects', async () => {
    const docker = makeDocker(vi.fn().mockRejectedValue(new Error('nope')))
    await expect(existsVolume(docker, 'vol')).resolves.toBe(false)
  })
})

describe('ensureVolumeExists', () => {
  it('creates the volume when it is missing', async () => {
    const scopedConsole = { write: vi.fn() } as any
    const docker = makeDocker(vi.fn().mockRejectedValue(new Error('missing')))
    await ensureVolumeExists(docker, scopedConsole, 'vol')

    expect(docker.createVolume).toHaveBeenCalledWith({ Name: 'vol', Driver: 'local', Labels: { app: 'hammerkit' } })
  })

  it('only debug-writes when the volume already exists', async () => {
    const scopedConsole = { write: vi.fn() } as any
    const docker = makeDocker(vi.fn().mockResolvedValue({ Name: 'vol' }))
    await ensureVolumeExists(docker, scopedConsole, 'vol')

    expect(docker.createVolume).not.toHaveBeenCalled()
    expect(scopedConsole.write).toHaveBeenCalledWith('debug', 'volume exists vol')
  })
})

describe('removeVolume', () => {
  it('returns true on success', async () => {
    const scopedConsole = { write: vi.fn() } as any
    const remove = vi.fn().mockResolvedValue(undefined)
    const docker = makeDocker(vi.fn(), remove)
    await expect(removeVolume(docker, scopedConsole, 'vol')).resolves.toBe(true)
    expect(remove).toHaveBeenCalledWith({ force: true })
  })

  it('returns false and warns on failure', async () => {
    const scopedConsole = { write: vi.fn() } as any
    const docker = makeDocker(vi.fn().mockRejectedValue(new Error('boom')))
    await expect(removeVolume(docker, scopedConsole, 'vol')).resolves.toBe(false)
    expect(scopedConsole.write).toHaveBeenCalledWith('warn', expect.stringContaining('removing volume vol failed'))
  })
})

describe('recreateVolume', () => {
  it('removes then creates the volume', async () => {
    const scopedConsole = { write: vi.fn() } as any
    const remove = vi.fn().mockResolvedValue(undefined)
    const docker = makeDocker(vi.fn(), remove)
    await recreateVolume(docker, scopedConsole, 'vol')

    expect(remove).toHaveBeenCalledWith({ force: true })
    expect(docker.createVolume).toHaveBeenCalledWith({ Name: 'vol', Driver: 'local', Labels: { app: 'hammerkit' } })
  })
})
