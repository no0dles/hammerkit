import { createHash } from 'crypto'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { ContainerWorkService, getServiceWorkingDir } from './work-service'
import { WorkItem } from './work-item'

const services = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': {
    envs: { CORE_DIR: '/app/core' },
    services: {
      plain: { image: 'postgres:16' },
      pinned: { image: 'example/core:6', workdir: '/app/core' },
      templated: { image: 'example/core:6', workdir: '$CORE_DIR' },
    },
  },
}

async function loadServices(name: string): Promise<{ [name: string]: WorkItem<ContainerWorkService> }> {
  const items: { [name: string]: WorkItem<ContainerWorkService> } = {}
  await createTestCase(name, services).setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
    for (const item of cli.ls()) {
      if (item.type === 'service') {
        items[item.item.name] = item.item as WorkItem<ContainerWorkService>
      }
    }
  })
  return items
}

describe('service workdir', () => {
  it('defaults to the build file directory', async () => {
    const { plain } = await loadServices('service-workdir-default')
    expect(plain.data.workdir).toBeNull()
    expect(getServiceWorkingDir(plain.data)).toEqual(plain.data.cwd)
  })

  it('uses the declared working directory inside the container', async () => {
    const { pinned } = await loadServices('service-workdir-declared')
    expect(pinned.data.workdir).toEqual('/app/core')
    expect(getServiceWorkingDir(pinned.data)).toEqual('/app/core')
  })

  it('substitutes build file envs', async () => {
    const { templated } = await loadServices('service-workdir-envs')
    expect(templated.data.workdir).toEqual('/app/core')
  })

  it('keeps the id of services without workdir and changes it with one', async () => {
    const { plain, pinned } = await loadServices('service-workdir-id')
    // the id inputs before `workdir` existed: a service that does not declare
    // it must keep its id, so existing service state stays valid
    const legacyPlainId = createHash('sha1')
      .update(JSON.stringify({ cwd: '.', image: 'postgres:16', volumes: [], src: [], mounts: [] }))
      .digest('hex')
    expect(plain.id()).toEqual(legacyPlainId)

    const withoutWorkdir = createHash('sha1')
      .update(JSON.stringify({ cwd: '.', image: 'example/core:6', volumes: [], src: [], mounts: [] }))
      .digest('hex')
    expect(pinned.id()).not.toEqual(withoutWorkdir)
  })
})
