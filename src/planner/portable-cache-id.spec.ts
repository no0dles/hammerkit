import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { join } from 'path'
import { getWorkInstanceId } from './work-instance-id'

// Cache identity must not depend on where a project is checked out. An agent
// sandbox (`/workspace/app`) and a CI runner (`/home/runner/work/app/app`) have
// to compute the same task id, otherwise a shared remote cache never hits.

const project = {
  // marks the project (git) root that identity paths are made relative to
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': {
    references: { web: 'apps/web', api: 'apps/api' },
    tasks: {
      build: {
        image: 'node:24-alpine',
        src: ['src'],
        generates: ['dist'],
        mounts: ['~/.npm:/root/.npm', 'config:/config'],
        cmds: ['echo build', { cmd: 'echo sub', path: 'src' }],
      },
      lint: {
        src: ['src'],
        cmds: ['echo lint'],
      },
    },
    services: {
      db: {
        image: 'postgres:16',
        ports: ['5432'],
        src: ['config'],
        mounts: ['config:/etc/db'],
      },
    },
  },
  'src/index.ts': 'export {}\n',
  'config/app.json': '{}\n',
  // two packages with byte-identical build files — they must not share an id
  'apps/web/.hammerkit.yaml': { tasks: { test: { image: 'node:24-alpine', src: ['src'], cmds: ['echo test'] } } },
  'apps/web/src/a.ts': 'export {}\n',
  'apps/api/.hammerkit.yaml': { tasks: { test: { image: 'node:24-alpine', src: ['src'], cmds: ['echo test'] } } },
  'apps/api/src/a.ts': 'export {}\n',
}

async function collectIds(name: string, instance = false): Promise<{ [name: string]: string }> {
  const ids: { [name: string]: string } = {}
  // parse only (no clean/exec): identity is a pure function of the work tree,
  // so this needs neither docker nor a cache backend
  await createTestCase(name, project).setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
    for (const item of cli.ls()) {
      ids[`${item.type}:${item.item.name}`] = instance ? getWorkInstanceId(item.item) : item.item.id()
    }
  })
  return ids
}

describe('portable cache id', () => {
  it('computes identical ids for the same project in different checkout locations', async () => {
    const first = await collectIds('portable-cache-id-checkout-a')
    const second = await collectIds('portable-cache-id-checkout-b/nested/deeper')

    expect(Object.keys(first).sort()).toEqual([
      'service:db',
      'task:api:test',
      'task:build',
      'task:lint',
      'task:web:test',
    ])
    expect(second).toEqual(first)
  })

  it('keeps ids distinct for identical build files in different project directories', async () => {
    const ids = await collectIds('portable-cache-id-packages')
    expect(ids['task:web:test']).not.toEqual(ids['task:api:test'])
  })

  it('keeps machine-local instance ids distinct across checkouts of the same project', async () => {
    // two worktrees on one host share cache ids but must not share runtime state
    // (docker containers, cache staging directories)
    const first = await collectIds('portable-cache-id-worktree-a', true)
    const second = await collectIds('portable-cache-id-worktree-b', true)
    for (const key of Object.keys(first)) {
      expect(second[key]).not.toEqual(first[key])
    }
  })
})
