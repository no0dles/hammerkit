import { printContainerOptions } from './print-container-options'
import { createServerTools, serverToolsBinds } from '../docker/server-tools'

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

  it('does not print the folder of the server’s tools', () => {
    const status = makeStatus()
    const tools = createServerTools('/var/lib/hammerkit/tools/busybox')
    printContainerOptions(
      status,
      {
        Image: 'alpine',
        Entrypoint: [`${tools.folder}/busybox`],
        HostConfig: { Binds: serverToolsBinds(tools) },
      } as any,
      tools
    )

    expect(status.write).toHaveBeenCalledWith('debug', 'create container with image alpine with /.hammerkit-…/busybox')
    expect(status.write).toHaveBeenCalledWith('debug', 'bind /var/lib/hammerkit/tools/busybox:/.hammerkit-…/busybox:ro')
    expect(JSON.stringify(status.write.mock.calls)).not.toContain(tools.folder)
  })
})
