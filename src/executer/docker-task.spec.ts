import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { buildCreateOptions } from './docker-task'
import { ContainerCreateOptions } from 'dockerode'

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

// A task that adds capabilities (`capAdd`), such as SYS_ADMIN for a daemonless image build
describe('container task capabilities', () => {
  async function createHostConfig(
    name: string,
    task: { [key: string]: unknown },
    hosted?: { capabilityRuntime?: string }
  ) {
    let config: ContainerCreateOptions['HostConfig']
    await createTestCase(name, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': { tasks: { build: { image: 'moby/buildkit:v0.25.1', cmds: ['true'], ...task } } },
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      const item = cli.task('build') as any
      const on = hosted ? { ...environment, hosted: { catalog: {} as any, ...hosted } } : environment
      config = buildCreateOptions(item, 'state', {}, on, { env: {}, binds: [] }).HostConfig
    })
    return config
  }

  it('adds what the task names, on this machine as on the docker host of a server', async () => {
    expect((await createHostConfig('cap-none', {}))?.CapAdd).toBeUndefined()
    const local = await createHostConfig('cap-local', { capAdd: ['SYS_ADMIN'] })
    expect(local?.CapAdd).toEqual(['SYS_ADMIN'])
    expect(local?.Runtime).toBeUndefined()
    // on a server only in the sandboxed runtime the operator names
    const hosted = await createHostConfig('cap-hosted', { capAdd: ['SYS_ADMIN'] }, { capabilityRuntime: 'runsc' })
    expect(hosted).toMatchObject({ CapAdd: ['SYS_ADMIN'], Runtime: 'runsc' })
    // the others keep the daemon's default runtime
    expect((await createHostConfig('cap-hosted-none', {}, { capabilityRuntime: 'runsc' }))?.Runtime).toBeUndefined()
  })

  it('refuses capabilities on a server without a sandboxed runtime', async () => {
    await expect(createHostConfig('cap-unsandboxed', { capAdd: ['SYS_ADMIN'] }, {})).rejects.toThrow(
      'build: adds the capabilities SYS_ADMIN, which this server grants in no sandboxed runtime'
    )
  })
})
