import { getCacheHelperOptions } from './work-runtime-docker'

describe('docker cache helper', () => {
  // the helper runs the item's own image with its outputs mounted
  it('has no network, whatever the network of the item', () => {
    for (const network of [{ type: 'open' }, { type: 'none' }, { type: 'allow', hosts: ['a.com'] }]) {
      const item = {
        id: () => 'build',
        name: 'build',
        data: {
          type: 'container-task',
          image: 'node:24-alpine',
          cwd: '/repo',
          projectRoot: '/repo',
          network,
          generates: [
            { path: '/repo/dist', volumeName: 'hammerkit-dist', isFile: false, inherited: false },
            { path: '/repo/node_modules', volumeName: 'hammerkit-deps', isFile: false, inherited: true },
          ],
        },
      } as any
      const options = getCacheHelperOptions(item, { abortCtrl: new AbortController() } as any)
      expect(options.Image).toBe('node:24-alpine')
      expect(options.HostConfig).toMatchObject({ NetworkMode: 'none', Binds: ['hammerkit-dist:/repo/dist'] })
      expect(options.HostConfig).not.toHaveProperty('Links')
      expect(options.HostConfig).not.toHaveProperty('ExtraHosts')
    }
  })
})
