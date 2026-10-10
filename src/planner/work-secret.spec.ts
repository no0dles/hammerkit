import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { WorkItem } from './work-item'
import { WorkTask } from './work-task'
import { ParseError } from '../schema/parse-error'

describe('task secrets', () => {
  async function describeTask(name: string, task: { [key: string]: unknown }, envs: { [key: string]: string }) {
    let result: { id: string; description: string } | null = null
    await createTestCase(name, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': { tasks: { build: { image: 'alpine:3.21', cmds: ['true'], ...task } } },
    }).setup(async (cwd, environment) => {
      environment.processEnvs = { ...environment.processEnvs, ...envs }
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      const item = cli.task('build') as unknown as WorkItem<WorkTask>
      result = { id: item.id(), description: JSON.stringify(getWorkTaskCacheDescription(item)) }
    })
    return result!
  }

  it('keeps a secret out of the cache key by default', async () => {
    const secrets = [{ from: 'env:API_TOKEN', env: 'TOKEN' }]
    const first = await describeTask('secret-default-a', { secrets }, { API_TOKEN: 'value-one' })
    const second = await describeTask('secret-default-a', { secrets }, { API_TOKEN: 'value-two' })
    expect(first.id).toEqual(second.id)
    expect(first.description).not.toContain('TOKEN')
  })

  it('needs no value for a task that is only planned', async () => {
    const description = await describeTask('secret-unset', { secrets: [{ from: 'env:UNSET_TOKEN', env: 'TOKEN' }] }, {})
    expect(description.id).toBeTruthy()
  })

  it('keys a cache-affecting secret by a digest, never the value', async () => {
    const secrets = [{ from: 'env:API_TOKEN', env: 'TOKEN', cache: true }]
    const first = await describeTask('secret-cache-a', { secrets }, { API_TOKEN: 'value-one' })
    const second = await describeTask('secret-cache-a', { secrets }, { API_TOKEN: 'value-two' })
    expect(first.id).not.toEqual(second.id)
    expect(first.description).toContain('TOKEN=sha256:')
    expect(first.description).not.toContain('value-one')
  })

  it('keys a file target the same on every checkout', async () => {
    const secrets = [{ from: 'env:API_TOKEN', path: 'creds/key.json', cache: true }]
    const first = await describeTask('secret-portable-a', { secrets }, { API_TOKEN: 'value-one' })
    const second = await describeTask('secret-portable-b', { secrets }, { API_TOKEN: 'value-one' })
    expect(first.description).toContain('creds/key.json=sha256:')
    expect(first.description).toEqual(second.description)
  })

  it('refuses a file target on a local task', async () => {
    await expect(
      createTestCase('secret-local-file', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: { build: { cmds: ['true'], secrets: [{ from: 'env:API_TOKEN', path: 'key.json' }] } },
        },
      }).setup(async (cwd, environment) => {
        await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      })
    ).rejects.toThrow('a local task takes secrets as env only')
  })

  it('refuses a secret with both an env and a path target', async () => {
    const error = await describeTask(
      'secret-both-targets',
      { secrets: [{ from: 'env:API_TOKEN', env: 'TOKEN', path: 'key.json' }] },
      {}
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ParseError)
    expect((error as ParseError).zod.issues.map((i) => i.message)).toContain(
      'a secret needs exactly one of env or path'
    )
  })
})
