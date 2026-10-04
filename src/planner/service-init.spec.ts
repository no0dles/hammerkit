import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { ContainerWorkService } from './work-service'
import { WorkItem } from './work-item'
import { getServiceInitTask } from './service-init-task'
import { getInitTimeout } from './utils/append-work-service'
import { Environment } from '../executer/environment'

const buildFile = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': {
    services: {
      plain: { image: 'postgres:16' },
      seeded: {
        image: 'postgres:16',
        envs: { DB: 'app', USER: 'svc' },
        init: {
          envs: { USER: 'init' },
          mounts: ['seed.sql:/seed.sql:ro'],
          cmds: ['psql -d $DB -f /seed.sql'],
          timeout: '30s',
        },
      },
      tooled: { image: 'keycloak:25', init: { image: 'curl:8', shell: 'bash', cmds: ['./assign.sh'] } },
    },
  },
}

async function loadServices(name: string): Promise<{ [name: string]: WorkItem<ContainerWorkService> }> {
  const items: { [name: string]: WorkItem<ContainerWorkService> } = {}
  await createTestCase(name, buildFile).setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
    for (const item of cli.ls()) {
      if (item.type === 'service') {
        items[item.item.name] = item.item as WorkItem<ContainerWorkService>
      }
    }
  })
  return items
}

describe('service init', () => {
  it('is null without an init block', async () => {
    const { plain } = await loadServices('service-init-plain')
    expect(plain.data.init).toBeNull()
  })

  it('defaults to the service image and sh, with the service envs under its own', async () => {
    const { seeded, tooled } = await loadServices('service-init-parse')
    expect(seeded.data.init).toMatchObject({ image: 'postgres:16', shell: 'sh', timeout: 30000 })
    expect(seeded.data.init?.envs.variables).toMatchObject({ DB: 'app', USER: 'init' })
    expect(seeded.data.init?.mounts[0]).toMatchObject({ containerPath: '/seed.sql', readOnly: true })
    expect(tooled.data.init).toMatchObject({ image: 'curl:8', shell: 'bash' })
  })

  it('runs as a container task that needs the service by its name', async () => {
    const { seeded } = await loadServices('service-init-task')
    const task = getServiceInitTask(seeded as any, seeded.data.init!, { containerId: 'abc' })
    expect(task.data).toMatchObject({ type: 'container-task', image: 'postgres:16', user: null, generates: [] })
    expect(task.needs[0].name).toEqual('seeded')
    expect(task.needs[0].service.state.current).toMatchObject({ type: 'running', dns: { containerId: 'abc' } })
  })

  it('takes the init timeout, else HAMMERKIT_INIT_TIMEOUT, else 5 minutes', () => {
    const env = (value?: string) => ({ processEnvs: value ? { HAMMERKIT_INIT_TIMEOUT: value } : {} }) as Environment
    expect(getInitTimeout('10s', env('1m'))).toEqual(10000)
    expect(getInitTimeout(undefined, env('1m'))).toEqual(60000)
    expect(getInitTimeout(undefined, env())).toEqual(300000)
    expect(() => getInitTimeout(undefined, env('soon'))).toThrow('HAMMERKIT_INIT_TIMEOUT')
  })
})
