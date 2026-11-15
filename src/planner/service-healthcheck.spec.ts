import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { ContainerWorkService, getHealthcheckCommand } from './work-service'
import { WorkItem } from './work-item'
import { getHealthcheckTimeoutMessage } from './work-healthcheck'

const services = {
  '.hammerkit.yaml': {
    services: {
      command: { image: 'postgres:16', healthcheck: { cmd: 'pg_isready -U postgres' } },
      web: { image: 'jaegertracing/all-in-one:1.62.0', healthcheck: { http: { port: 14269 } } },
      keycloak: {
        image: 'quay.io/keycloak/keycloak:26.0',
        healthcheck: {
          http: { port: 9000, path: '/health/ready', scheme: 'https', status: [200, 401] },
          timeout: '2m',
        },
      },
      cache: { image: 'redis:7-alpine', healthcheck: { tcp: { port: 6379 } } },
    },
  },
}

async function loadServices(): Promise<{ [name: string]: WorkItem<ContainerWorkService> }> {
  const items: { [name: string]: WorkItem<ContainerWorkService> } = {}
  await createTestCase('service-healthcheck', services).setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
    for (const item of cli.ls()) {
      if (item.type === 'service') {
        items[item.item.name] = item.item as WorkItem<ContainerWorkService>
      }
    }
  })
  return items
}

describe('service healthcheck', () => {
  it('requests / over http and takes any 2xx or 3xx when the build file says nothing else', async () => {
    const { web } = await loadServices()
    expect(web.data.healthcheck).toEqual({
      http: { port: 14269, path: '/', scheme: 'http', status: null },
      timeout: 20_000,
    })
    // no command runs in the service's container
    expect(getHealthcheckCommand(web.data)).toBeNull()
  })

  it('keeps the path, scheme, status codes and timeout of a request', async () => {
    const { keycloak } = await loadServices()
    expect(keycloak.data.healthcheck).toEqual({
      http: { port: 9000, path: '/health/ready', scheme: 'https', status: [200, 401] },
      timeout: 120_000,
    })
    expect(getHealthcheckTimeoutMessage('keycloak', keycloak.data.healthcheck!)).toContain(
      'service keycloak did not pass its healthcheck "GET https://:9000/health/ready (200, 401)" within 2m'
    )
  })

  it('connects to the port of a tcp check, and keeps a cmd as it was', async () => {
    const { cache, command } = await loadServices()
    expect(cache.data.healthcheck).toEqual({ tcp: { port: 6379 }, timeout: 20_000 })
    expect(getHealthcheckTimeoutMessage('cache', cache.data.healthcheck!)).toContain('healthcheck "tcp :6379"')
    expect(getHealthcheckCommand(cache.data)).toBeNull()
    expect(getHealthcheckCommand(command.data)).toEqual(['pg_isready', '-U', 'postgres'])
  })
})
