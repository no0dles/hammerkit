import { join } from 'path'
import Dockerode from 'dockerode'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// A service resolves its own name (a database advertising its own address),
// and `run` reaches a service over its link without publishing its ports.
describe('service hostname and ports', () => {
  it(
    'resolves its own name and keeps host ports unpublished during run',
    requiresLinuxContainers(async () => {
      await createTestCase('service-self-hostname', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            db: {
              image: 'alpine:3.19',
              shell: 'sh',
              cmd: 'nc -lk -p 5000 -e echo ok',
              ports: ['15000:5000'],
              healthcheck: { cmd: 'nc -z db 5000' },
            },
          },
          tasks: {
            test: {
              image: 'alpine:3.19',
              needs: ['db'],
              src: ['in.txt'],
              cmds: ['nc -z db 5000', 'cat in.txt'],
            },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        await cli.clean({ cache: true })
        const published: string[] = []
        const docker = new Dockerode()
        const poll = setInterval(async () => {
          for (const container of await docker.listContainers({ filters: { label: ['hammerkit-type=service'] } })) {
            for (const port of container.Ports) {
              if (port.PublicPort) {
                published.push(`${port.PublicPort}`)
              }
            }
          }
        }, 200)
        try {
          const result = await cli.runExec()
          expect(result.success).toBe(true)
        } finally {
          clearInterval(poll)
        }
        expect(published).toEqual([])
      })
    }),
    120000
  )

  it(
    'publishes the ports when a local task needs the service',
    requiresLinuxContainers(async () => {
      await createTestCase('service-ports-local-task', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            web: {
              image: 'alpine:3.19',
              shell: 'sh',
              cmd: 'nc -lk -p 5000 -e echo ok',
              ports: ['15001:5000'],
              healthcheck: { cmd: 'nc -z web 5000' },
            },
          },
          tasks: {
            probe: {
              needs: ['web'],
              src: ['in.txt'],
              cmds: [
                `node -e "require('net').connect(+process.env.HAMMERKIT_WEB_PORT, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"`,
              ],
            },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'probe' })
        await cli.clean({ cache: true })
        expect((await cli.runExec()).success).toBe(true)
      })
    }),
    120000
  )
})
