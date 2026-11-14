import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { getCheckKeys } from './check-keys'

const project = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': {
    tasks: {
      build: { image: 'node:24-alpine', src: ['src'], generates: ['dist'], cmds: ['cp -r src dist'] },
      test: { deps: ['build'], src: ['test'], cmds: ['node --test'] },
      // reads a secret of the server's provider: the provider is no part of the key
      e2e: {
        deps: ['build'],
        src: ['e2e'],
        secrets: [{ from: 'gsm:e2e-token', account: 'e2e', env: 'TOKEN' }],
        cmds: ['node e2e.js'],
      },
      deploy: {
        deps: ['test'],
        src: ['deploy.js'],
        secrets: [{ from: 'gsm:deploy-token', account: 'deploy', env: 'TOKEN', cache: true }],
        cmds: ['node deploy.js'],
      },
    },
  },
  'src/a.ts': 'a\n',
  'test/a.spec.ts': 'spec\n',
  'e2e/a.ts': 'e2e\n',
  'deploy.js': 'deploy\n',
}

describe('check keys', () => {
  it('are the same on a server, which has the providers, and in a checkout, which has none', async () => {
    let plain: unknown
    await createTestCase('check-keys-plain', project).setup(async (cwd, environment) => {
      plain = await getCheckKeys(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'e2e' })
    })
    let server: unknown
    await createTestCase('check-keys-server/elsewhere', project).setup(async (cwd, environment) => {
      environment.hosted = {
        catalog: {
          providers: {
            gsm: { name: 'gsm', type: 'command', command: ['gcloud'], env: {}, timeoutMs: 1000, declaredIn: 'x' },
          },
          accounts: {},
          explicitAccounts: true,
        },
        localTasksInContainers: true,
      }
      server = await getCheckKeys(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'e2e' })
    })
    expect(Object.keys(plain as object).sort()).toEqual(['build', 'e2e'])
    expect((plain as { e2e: { key: string } }).e2e.key).toMatch(/^[0-9a-f]{64}$/)
    expect(server).toEqual(plain)
  })

  it('has none for a task whose key holds a secret’s value', async () => {
    await createTestCase('check-keys-cached-secret', project).setup(async (cwd, environment) => {
      const keys = await getCheckKeys(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'deploy' })
      expect(keys.test.key).toMatch(/^[0-9a-f]{64}$/)
      expect(keys.deploy).toEqual({ key: null, reason: expect.stringContaining('deploy-token') })
    })
  })
})
