import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { ContainerWorkService } from './work-service'
import { WorkItem, WorkItemState } from './work-item'
import { resolveEffective } from '../executer/scheduler/state-key'
import { getInitTimeout } from './utils/append-work-service'
import { Environment } from '../executer/environment'
import { WorkTask } from './work-task'

const buildFile = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': {
    services: {
      plain: { image: 'postgres:16' },
      db: { image: 'postgres:16', init: 'seed' },
      idp: { image: 'idp:25', init: 'roles' },
    },
    tasks: {
      seed: { image: 'postgres:16', cmds: ['psql -h db -f seed.sql'] },
      roles: { image: 'curl:8', needs: ['idp'], timeout: '30s', cmds: ['./assign.sh'] },
      app: { image: 'alpine:3.21', needs: ['db'], cmds: ['true'] },
    },
  },
}

const includedBuildFile = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': {
    includes: { services: 'services.yaml' },
  },
  'services.yaml': {
    services: {
      db: { image: 'postgres:16', init: 'seed' },
      idp: { image: 'idp:25', init: 'roles' },
    },
    tasks: {
      seed: { image: 'postgres:16', cmds: ['psql -h db -f seed.sql'] },
      roles: { image: 'curl:8', needs: [{ name: 'keycloak', service: 'idp' }], cmds: ['./assign.sh'] },
    },
  },
}

async function load(name: string, taskName: string | null, files: { [key: string]: unknown } = buildFile) {
  const services: { [name: string]: WorkItem<ContainerWorkService> } = {}
  const tasks: { [name: string]: WorkItem<WorkTask> } = {}
  await createTestCase(name, files).setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, taskName ? { taskName } : {})
    for (const item of cli.ls()) {
      if (item.type === 'service') {
        services[item.item.name] = item.item as WorkItem<ContainerWorkService>
      } else {
        tasks[item.item.name] = item.item as WorkItem<WorkTask>
      }
    }
  })
  return { services, tasks }
}

function initOf(service: WorkItem<ContainerWorkService>) {
  const init = service.data.init
  if (!init) {
    throw new Error(`${service.name} has no init`)
  }
  return init
}

describe('service init', () => {
  it('is null without init', async () => {
    const { services } = await load('service-init-plain', null)
    expect(services.plain.data.init).toBeNull()
  })

  it('is the named task, needing the service through a view by its name', async () => {
    const { services } = await load('service-init-parse', null)
    const init = services.db.data.init!
    expect(init.task.name).toEqual('seed')
    const self = init.task.needs.find((need) => need.name === 'db')!
    expect(self.service.state).toBe(init.state)
    expect(self.service.state).not.toBe((services.db as any).state)
  })

  it('replaces a need the task declares itself, and never requires the service', async () => {
    const { services } = await load('service-init-explicit-need', null)
    const init = services.idp.data.init!
    expect(init.task.needs.filter((need) => need.name === 'idp')).toHaveLength(1)
    expect(init.task.needs[0].service.state).toBe(init.state)
    expect(services.idp.requiredBy.map((r) => r.name)).not.toContain('roles')
  })

  it('needs a service of an include by its name in that file', async () => {
    const { services } = await load('service-init-included', null, includedBuildFile)
    const init = initOf(services['services:db'])
    expect(init.task.needs.map((need) => need.name)).toEqual(['db'])
    expect(init.task.needs[0].service.state).toBe(init.state)
  })

  it('keeps the name a task of an include declares for its service', async () => {
    const { services } = await load('service-init-included-explicit-need', null, includedBuildFile)
    const init = initOf(services['services:idp'])
    expect(init.task.needs.map((need) => need.name)).toEqual(['keycloak'])
    expect(init.task.needs[0].service.state).toBe(init.state)
  })

  it("refuses an init task that needs another service by its service's name", async () => {
    const files = {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        services: {
          db: { image: 'postgres:16', init: 'seed' },
          other: { image: 'postgres:16' },
        },
        tasks: {
          seed: { image: 'postgres:16', needs: [{ name: 'db', service: 'other' }], cmds: ['psql -h db'] },
        },
      },
    }
    await expect(load('service-init-need-twice', null, files)).rejects.toThrow(
      'seed needs two services as db, give one another name with name:'
    )
  })

  it('never comes from the cache and gets the init timeout unless it has its own', async () => {
    const { services } = await load('service-init-cache', null)
    expect(services.db.data.init!.task.data.caching.method).toEqual('none')
    expect(services.db.data.init!.task.data.timeout).toEqual(300000)
    expect(services.idp.data.init!.task.data.timeout).toEqual(30000)
  })

  it('stays uncached when the run falls back to the default cache method', async () => {
    const { services } = await load('service-init-cache-effective', null)
    const task = services.db.data.init!.task as unknown as WorkItemState<WorkTask, unknown>
    expect(resolveEffective(task, 'checksum').method).toEqual('none')
  })

  it('comes into the run with its service', async () => {
    const { tasks, services } = await load('service-init-scope', 'app')
    expect(Object.keys(services)).toEqual(['db'])
    expect(Object.keys(tasks).sort()).toEqual(['app', 'seed'])
  })

  it('takes HAMMERKIT_INIT_TIMEOUT, else 5 minutes', () => {
    const env = (value?: string) => ({ processEnvs: value ? { HAMMERKIT_INIT_TIMEOUT: value } : {} }) as Environment
    expect(getInitTimeout(undefined, env('1m'))).toEqual(60000)
    expect(getInitTimeout(undefined, env())).toEqual(300000)
    expect(() => getInitTimeout(undefined, env('soon'))).toThrow('HAMMERKIT_INIT_TIMEOUT')
  })
})
