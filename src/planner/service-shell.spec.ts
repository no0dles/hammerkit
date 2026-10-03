import { createHash } from 'crypto'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { ContainerWorkService, getHealthcheckCommand, getServiceCommand } from './work-service'
import { WorkItem } from './work-item'

const services = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': {
    services: {
      exec: {
        image: 'alpine:3.21',
        cmd: 'sleep "1 2"',
        healthcheck: { cmd: 'test -f /tmp/ready' },
      },
      shelled: {
        image: 'alpine:3.21',
        shell: '/bin/sh',
        cmd: 'cd /srv && exec ./start "$(hostname)"',
        healthcheck: { cmd: 'wget -qO- http://127.0.0.1:80 | grep -q ok' },
      },
      noCmd: { image: 'alpine:3.21', shell: '/bin/sh' },
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

describe('service shell', () => {
  it('keeps the exec form and the image entrypoint without a shell', async () => {
    const { exec } = await loadServices('service-shell-exec')
    expect(exec.data.shell).toBeNull()
    expect(getServiceCommand(exec.data)).toEqual({ entrypoint: null, cmd: ['sleep', '1 2'] })
    expect(getHealthcheckCommand(exec.data)).toEqual(['test', '-f', '/tmp/ready'])
  })

  it('runs cmd and healthcheck through the shell, replacing the entrypoint', async () => {
    const { shelled } = await loadServices('service-shell-shelled')
    expect(getServiceCommand(shelled.data)).toEqual({
      entrypoint: ['/bin/sh', '-c'],
      cmd: ['cd /srv && exec ./start "$(hostname)"'],
    })
    expect(getHealthcheckCommand(shelled.data)).toEqual(['/bin/sh', '-c', 'wget -qO- http://127.0.0.1:80 | grep -q ok'])
  })

  it('leaves the image entrypoint and command alone when there is no cmd', async () => {
    const { noCmd } = await loadServices('service-shell-no-cmd')
    expect(getServiceCommand(noCmd.data)).toEqual({ entrypoint: null, cmd: null })
    expect(getHealthcheckCommand(noCmd.data)).toBeNull()
  })

  it('keeps the id of services without shell', async () => {
    const { exec, shelled } = await loadServices('service-shell-id')
    // the id inputs before `shell` existed: services that don't declare it keep their id
    const legacyExecId = createHash('sha1')
      .update(JSON.stringify({ cwd: '.', image: 'alpine:3.21', volumes: [], src: [], mounts: [] }))
      .digest('hex')
    expect(exec.id()).toEqual(legacyExecId)
    expect(shelled.id()).not.toEqual(legacyExecId)
  })
})
