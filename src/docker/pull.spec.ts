import { pull } from './pull'

type ProgressCallback = (err: unknown, res: unknown) => void

function makeStatus() {
  return { console: vi.fn(), write: vi.fn() } as any
}

function makeDocker(images: Array<{ RepoTags?: string[] }> = []) {
  return {
    listImages: vi.fn().mockResolvedValue(images),
    pull: vi.fn().mockResolvedValue('image-stream'),
    modem: {
      followProgress: vi.fn((_stream: unknown, cb: ProgressCallback) => cb(null, {})),
    },
  } as any
}

describe('pull', () => {
  it('skips pulling when the image is already present', async () => {
    const status = makeStatus()
    const docker = makeDocker([{ RepoTags: ['nginx:latest'] }])

    await pull(status, docker, 'nginx:latest')

    expect(docker.listImages).toHaveBeenCalledWith({})
    expect(docker.pull).not.toHaveBeenCalled()
    expect(docker.modem.followProgress).not.toHaveBeenCalled()
    expect(status.write).not.toHaveBeenCalled()
  })

  it('searches untagged images with the :latest tag appended', async () => {
    const docker = makeDocker([{ RepoTags: ['nginx:latest'] }])

    await pull(makeStatus(), docker, 'nginx')

    expect(docker.pull).not.toHaveBeenCalled()
    expect(docker.modem.followProgress).not.toHaveBeenCalled()
  })

  it('pulls an untagged image with its original name', async () => {
    const status = makeStatus()
    const docker = makeDocker([])

    await pull(status, docker, 'nginx')

    expect(status.write).toHaveBeenCalledWith('debug', 'pull image nginx')
    expect(docker.pull).toHaveBeenCalledWith('nginx')
    expect(docker.modem.followProgress).toHaveBeenCalledWith('image-stream', expect.any(Function))
  })

  it('pulls a tagged image when it is missing', async () => {
    const status = makeStatus()
    const docker = makeDocker([{ RepoTags: ['alpine:latest'] }])

    await pull(status, docker, 'nginx:1.21')

    expect(status.write).toHaveBeenCalledWith('debug', 'pull image nginx:1.21')
    expect(docker.pull).toHaveBeenCalledWith('nginx:1.21')
    expect(docker.modem.followProgress).toHaveBeenCalledTimes(1)
  })

  it('rejects when followProgress reports an error', async () => {
    const docker = makeDocker([])
    docker.modem.followProgress.mockImplementation((_stream: unknown, cb: ProgressCallback) =>
      cb(new Error('pull failed'), null)
    )

    await expect(pull(makeStatus(), docker, 'nginx:latest')).rejects.toThrow('pull failed')
  })

  it('rejects when docker.pull fails', async () => {
    const docker = makeDocker([])
    docker.pull.mockRejectedValue(new Error('connection refused'))

    await expect(pull(makeStatus(), docker, 'nginx:latest')).rejects.toThrow('connection refused')
    expect(docker.modem.followProgress).not.toHaveBeenCalled()
  })
})
