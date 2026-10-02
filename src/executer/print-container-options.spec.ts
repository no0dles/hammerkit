import { printContainerOptions } from './print-container-options'

function makeStatus() {
  return { write: vi.fn() } as any
}

describe('printContainerOptions', () => {
  it('logs the image, entrypoint, binds and links', () => {
    const status = makeStatus()
    printContainerOptions(status, {
      Image: 'node:20',
      Entrypoint: ['/bin/sh'],
      HostConfig: { Binds: ['/host:/mnt', '/src:/src'], Links: ['a:b'] },
    } as any)

    expect(status.write).toHaveBeenCalledWith('debug', 'create container with image node:20 with /bin/sh')
    expect(status.write).toHaveBeenCalledWith('debug', 'bind /host:/mnt')
    expect(status.write).toHaveBeenCalledWith('debug', 'bind /src:/src')
    expect(status.write).toHaveBeenCalledWith('debug', 'link a:b')
  })

  it('only writes the image line when HostConfig is missing', () => {
    const status = makeStatus()
    printContainerOptions(status, { Image: 'alpine', Entrypoint: ['sh'] } as any)

    expect(status.write).toHaveBeenCalledTimes(1)
    expect(status.write).toHaveBeenCalledWith('debug', 'create container with image alpine with sh')
  })
})
