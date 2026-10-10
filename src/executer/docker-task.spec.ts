import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { buildCreateOptions } from './docker-task'

// On Linux hammerkit runs a container as the host's uid:gid, so files it writes
// into the project belong to the user. That uid has no home in the image, and
// Docker sets HOME=/, which isn't writable: npm, dotnet, go and maven fail to
// create their caches. The container gets a writable HOME instead.
describe('container task environment', () => {
  async function createOptions(name: string, task: { [key: string]: unknown }, user: string | null) {
    let env: string[] = []
    await createTestCase(name, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': { tasks: { build: { image: 'alpine:3.21', cmds: ['true'], ...task } } },
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      const item = cli.task('build') as any
      item.data.user = user
      env = buildCreateOptions(item, 'state', {}, environment, { env: {}, binds: [] }).Env ?? []
    })
    return env
  }

  it('gives a container running as the host user a writable HOME', async () => {
    expect(await createOptions('home-for-user', {}, '1001:1001')).toContain('HOME=/tmp')
  })

  it('keeps a HOME the task declares', async () => {
    const env = await createOptions('home-declared', { envs: { HOME: '/work' } }, '1001:1001')
    expect(env).toContain('HOME=/work')
    expect(env).not.toContain('HOME=/tmp')
  })

  it("leaves the image's HOME alone when it runs as the image's user", async () => {
    expect((await createOptions('home-image-user', {}, null)).some((e) => e.startsWith('HOME='))).toBe(false)
  })
})
