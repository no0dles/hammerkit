import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { applyNetworkCeiling } from './work-network'
import { getItemProxyEnvironment } from '../network/egress-proxy'

const services = { services: { postgres: { image: 'postgres:16' }, 'cache-db': { image: 'redis:7' } } }

async function plan(name: string, tasks: { [key: string]: unknown }) {
  const testCase = createTestCase(name, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': { includes: { services: './services.yaml' }, tasks },
    'services.yaml': services,
  })
  let result: Awaited<ReturnType<typeof createCli>> | undefined
  await testCase.setup(async (cwd, environment) => {
    result = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
  })
  return result!
}

describe('need names', () => {
  it('reaches a service of an include by its name with dashes for colons', async () => {
    const cli = await plan('need-names-include', {
      test: { image: 'node:22', cmds: ['true'], needs: ['services:postgres'] },
    })
    expect(cli.task('test').needs.map((need) => need.name)).toEqual(['services-postgres'])
    expect(cli.task('test').needs[0].service.name).toEqual('services:postgres')
  })

  it('keeps a name given with name:', async () => {
    const cli = await plan('need-names-explicit', {
      test: { image: 'node:22', cmds: ['true'], needs: [{ name: 'db', service: 'services:postgres' }] },
    })
    expect(cli.task('test').needs.map((need) => need.name)).toEqual(['db'])
  })

  it('lets a limited network reach it, since the name is a host name now', async () => {
    const cli = await plan('need-names-limited', {
      test: { image: 'node:22', cmds: ['true'], needs: ['services:postgres'], network: { allow: ['a.com'] } },
    })
    applyNetworkCeiling((cli as any).workTree, null)
    expect(getItemProxyEnvironment(cli.task('test'))).toMatchObject({ HAMMERKIT_NEEDS: '["services-postgres"]' })
  })

  it('refuses two needs that would be reached under one name', async () => {
    await expect(
      plan('need-names-twice', {
        test: {
          image: 'node:22',
          cmds: ['true'],
          needs: ['services:cache-db', { name: 'services-cache-db', service: 'services:postgres' }],
        },
      })
    ).rejects.toThrow('test needs two services as services-cache-db, give one another name with name:')
  })
})
