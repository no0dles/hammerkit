import { tmpdir } from 'os'
import { environmentMock } from '../executer/environment-mock'
import { Environment } from '../executer/environment'
import { getSecretCatalog, serverConfigSchema } from './server-config'
import { RepoAccess } from './repo-access'

const config = serverConfigSchema.parse({
  issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
  // the provider prints the reference it is asked for, the "token" of repo X is X
  secretProviders: { echo: { command: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '{{ref}}'] } },
  accounts: { 'scm-read': { providers: { echo: { env: {} } } } },
  sources: [
    { match: 'github.com/corp/special', secret: { from: 'echo:special-token', account: 'scm-read' } },
    { match: 'github.com/corp/*', secret: { from: 'echo:github-token-value', account: 'scm-read' } },
    {
      match: 'gitlab.corp.com/platform/**',
      secret: { from: 'echo:gitlab-token', account: 'scm-read', username: 'oauth2' },
    },
    { match: 'github.com/public/*' },
  ],
})

const environment: Environment = {
  ...environmentMock(tmpdir()),
  processEnvs: { PATH: process.env.PATH, HOME: '/home/x' },
  hosted: { catalog: getSecretCatalog(config) },
}

const basic = (user: string, token: string) =>
  `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`

describe('RepoAccess', () => {
  it('reads what the sources list covers, the first pattern first', () => {
    const repos = new RepoAccess(config, environment)
    expect(repos.readable('github.com/corp/payments')).toBe(true)
    expect(repos.readable('gitlab.corp.com/platform/team/sub/tool')).toBe(true)
    expect(repos.readable('gitlab.corp.com/other/tool')).toBe(false)
    expect(repos.readable('github.com/elsewhere/x')).toBe(false)
    expect(repos.source('github.com/corp/special')?.secret?.from).toBe('echo:special-token')
    expect(repos.source('github.com/corp/payments')?.secret?.from).toBe('echo:github-token-value')
  })

  it('fetches from https unless it is told otherwise', () => {
    expect(new RepoAccess(config, environment).url('github.com/corp/payments')).toBe(
      'https://github.com/corp/payments.git'
    )
    expect(new RepoAccess(config, environment, { url: () => '/tmp/x' }).url('github.com/corp/payments')).toBe('/tmp/x')
  })

  it('hands the token to git for that host only, through the environment of the git process', async () => {
    const credentials = await new RepoAccess(config, environment).credentials('github.com/corp/payments')
    expect(credentials.env).toMatchObject({
      PATH: process.env.PATH,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: basic('x-access-token', 'github-token-value'),
    })
    // both the token and the header it travels in are masked in the run's logs
    expect(credentials.values).toEqual(['github-token-value', basic('x-access-token', 'github-token-value')])

    const gitlab = await new RepoAccess(config, environment).credentials('gitlab.corp.com/platform/a/b')
    expect(gitlab.env.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.corp.com/.extraHeader')
    expect(gitlab.env.GIT_CONFIG_VALUE_0).toBe(basic('oauth2', 'gitlab-token'))
  })

  it('pushes with the secret of the source and nothing of the server user', async () => {
    const repos = new RepoAccess(config, environment)
    const push = await repos.pushCredentials('github.com/corp/payments')
    expect(push.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader')
    expect(push.env.GIT_CONFIG_VALUE_0).toBe(basic('x-access-token', 'github-token-value'))
    expect(push.values).toEqual(['github-token-value', basic('x-access-token', 'github-token-value')])
    // nothing of the server user's own git: no global or system config, credential helper,
    // .netrc in the home directory or ssh agent
    expect(push.env.HOME).toBeUndefined()
    expect(push.env).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    })
    // a repository read without a secret is not pushed to
    await expect(repos.pushCredentials('github.com/public/x')).rejects.toThrow(
      'this server does not push to github.com/public/x'
    )
  })

  it('sends nothing for a public repository, and nothing of the server beyond its allowlist', async () => {
    const credentials = await new RepoAccess(config, environment).credentials('github.com/public/x')
    expect(credentials.values).toEqual([])
    expect(credentials.env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(credentials.env.HOME).toBe('/home/x')
  })

  it('reads the token again after a minute, not before', async () => {
    let now = 0
    let reads = 0
    const counting = serverConfigSchema.parse({
      ...config,
      secretProviders: {
        echo: {
          command: [process.execPath, '-e', 'process.stdout.write(process.argv[1] + Math.random())', '{{ref}}'],
        },
      },
    })
    const repos = new RepoAccess(
      counting,
      { ...environment, hosted: { catalog: getSecretCatalog(counting) } },
      { now: () => now }
    )
    const first = await repos.credentials('github.com/corp/payments')
    reads++
    now = 59_000
    expect((await repos.credentials('github.com/corp/payments')).values[0]).toBe(first.values[0])
    now = 61_000
    expect((await repos.credentials('github.com/corp/payments')).values[0]).not.toBe(first.values[0])
    expect(reads).toBe(1)
  })

  it('says when the credential can not be read, without the operator having to guess', async () => {
    const failing = serverConfigSchema.parse({
      ...config,
      secretProviders: { echo: { command: [process.execPath, '-e', 'process.exit(3)', '{{ref}}'] } },
    })
    const repos = new RepoAccess(failing, { ...environment, hosted: { catalog: getSecretCatalog(failing) } })
    await expect(repos.credentials('github.com/corp/payments')).rejects.toThrow(
      'could not read the source credential echo:github-token-value'
    )
  })

  it('takes the commit from the resolver it is given', async () => {
    const repos = new RepoAccess(config, environment, { resolve: async (repo, ref) => `${repo}@${ref}` })
    expect(await repos.resolve('github.com/corp/x', 'main')).toBe('github.com/corp/x@main')
  })

  it('removes the token from an error', () => {
    const repos = new RepoAccess(config, environment)
    const error = repos.scrub(new Error('remote said: bad credentials github-token-value'), ['github-token-value'])
    expect(error.message).toBe('remote said: bad credentials ***')
  })
})
