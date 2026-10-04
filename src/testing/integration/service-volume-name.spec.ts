import { join } from 'path'
import Dockerode from 'dockerode'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// A volume named after one of the service's envs: CI jobs sharing a docker
// host each get their own volume.
describe('service volume name', () => {
  it(
    'names the volume from the service envs',
    requiresLinuxContainers(async () => {
      const prefix = `hk-volume-${process.pid}`
      await createTestCase('service-volume-name', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            db: {
              image: 'alpine:3.19',
              cmd: 'sleep 300',
              envs: { DATA_PREFIX: '${HK_TEST_DATA_PREFIX:-dev}' },
              volumes: ['${DATA_PREFIX}-data:/data'],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, HK_TEST_DATA_PREFIX: prefix }
        const docker = new Dockerode()
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
        try {
          expect((await cli.runUp({ daemon: true })).success).toBe(true)
          const volume = await docker.getVolume(`${prefix}-data`).inspect()
          expect(volume.Name).toEqual(`${prefix}-data`)
        } finally {
          await cli.runDown()
          await docker
            .getVolume(`${prefix}-data`)
            .remove()
            .catch(() => undefined)
        }
      })
    }),
    120000
  )
})
