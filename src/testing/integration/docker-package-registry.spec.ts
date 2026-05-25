import { createTestCase } from '../test-case'
import { ensureLocalRegistry, LocalRegistry } from '../ensure-local-registry'
import { requiresLinuxContainers } from '../requires-linux-containers'

describe('docker/package against a local registry', () => {
  let registry: LocalRegistry

  beforeAll(
    requiresLinuxContainers(async () => {
      registry = await ensureLocalRegistry()
    })
  )

  afterAll(async () => {
    if (registry && process.env.HAMMERKIT_KEEP_REGISTRY !== 'true') {
      await registry.cleanup()
    }
  })

  it(
    'pushes a built service image and the registry lists its tag',
    requiresLinuxContainers(async () => {
      const repository = `pkg-${Date.now()}`
      const testCase = createTestCase('docker-package-registry', {
        '.hammerkit.yaml': {
          services: {
            [repository]: {
              image: 'alpine:3.19',
              labels: { app: 'svc' },
              cmd: 'sh -c "echo hi && sleep 3600"',
              src: ['hello.txt'],
              ports: ['8080'],
            },
          },
        },
        'hello.txt': 'hi from hammerkit',
      })

      await testCase.cli({ filterLabels: { app: ['svc'] } }, async (cli) => {
        await cli.package({
          registry: `${registry.host}:${registry.hostPort}`,
          push: true,
          overrideUser: false,
          username: null,
          password: null,
        })
      })

      expect(await registry.listsTag(repository, 'latest')).toBe(true)
    }),
    180000
  )
})
