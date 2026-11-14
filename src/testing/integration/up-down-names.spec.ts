import { join } from 'path'
import { createTestCase } from '../test-case'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { createCli } from '../../program'
import { Environment } from '../../executer/environment'

// `up` and `down` by name start and stop the named services and the services the
// named tasks need, and leave the others as they are.
describe('up and down by name', () => {
  // a workdir of its own each: same image and mounts would be the same service
  const service = (workdir: string) => ({ image: 'alpine:3.19', cmd: 'sleep 600', ports: [':9000'], workdir })
  const testCase = createTestCase('up-down-names', {
    '.hammerkit.yaml': {
      services: { db: service('/db'), cache: service('/cache'), mail: service('/mail') },
      tasks: { serve: { image: 'alpine:3.19', cmds: ['true'], needs: ['cache'] } },
    },
  })

  async function running(cwd: string, environment: Environment): Promise<string[]> {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
    const names: string[] = []
    for (const name of ['cache', 'db', 'mail']) {
      const service = cli.service(name)
      await service.runtime.initialize(service.state)
      if (service.state.current.type === 'running') {
        names.push(name)
      }
    }
    return names
  }

  it(
    'starts and stops only what is named',
    requiresLinuxContainers(async () => {
      await testCase.setup(async (cwd, environment) => {
        const file = join(cwd, '.hammerkit.yaml')
        try {
          const db = await createCli(file, environment, { names: ['db'] })
          expect((await db.runUp({ daemon: true })).success).toBe(true)
          expect(await running(cwd, environment)).toEqual(['db'])

          const serve = await createCli(file, environment, { names: ['serve', 'mail'] })
          expect((await serve.runUp({ daemon: true })).success).toBe(true)
          expect(await running(cwd, environment)).toEqual(['cache', 'db', 'mail'])

          const down = await createCli(file, environment, { names: ['serve', 'db'] })
          expect((await down.runDown()).success).toBe(true)
          expect(await running(cwd, environment)).toEqual(['mail'])
        } finally {
          await (await createCli(file, environment, {})).runDown()
        }
      })
    }),
    180000
  )
})
