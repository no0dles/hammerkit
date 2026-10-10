import { join } from 'path'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { createGitRepo, GitRepo, isolateHammerkitHome } from '../git-repo'
import { expectSuccessfulResult } from '../expect'

describe('remote include', () => {
  let repo: GitRepo
  let home: ReturnType<typeof isolateHammerkitHome>

  beforeEach(() => {
    home = isolateHammerkitHome()
    repo = createGitRepo()
    repo.commit({
      'catalog/greet/build.yaml': [
        'tasks:',
        '  write:',
        '    cmds:',
        '      - echo from-remote > greeting.txt',
        '',
      ].join('\n'),
    })
  })
  afterEach(() => {
    repo.remove()
    home.restore()
  })

  const buildFile = () => ({
    '.hammerkit.yaml': [
      'includes:',
      '  greet:',
      `    git: ${repo.url}`,
      '    path: catalog/greet',
      'tasks:',
      '  greet:',
      '    deps: [greet:write]',
      '    cmds:',
      '      - cat greeting.txt',
      '',
    ].join('\n'),
  })

  const scope = { taskName: 'greet', environmentName: null }

  it('runs a task defined in a git repository, in the including directory', async () => {
    await createTestCase('remote-include', buildFile()).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, scope)
      await expectSuccessfulResult(await cli.runExec(), environment)

      expect(await environment.file.read(join(cwd, 'greeting.txt'))).toBe('from-remote\n')
    })
  })

  it('runs again offline from the cached checkout', async () => {
    await createTestCase('remote-include-offline', buildFile()).setup(async (cwd, environment) => {
      const online = await createCli(join(cwd, '.hammerkit.yaml'), environment, scope)
      await expectSuccessfulResult(await online.runExec(), environment)

      repo.remove()
      const offline = await createCli(join(cwd, '.hammerkit.yaml'), environment, scope)
      await expectSuccessfulResult(await offline.runExec(), environment)
    })
  })

  it('fails with the repository and ref when it was never cached', async () => {
    const files = buildFile()
    repo.remove()
    await createTestCase('remote-include-unreachable', files).setup(async (cwd, environment) => {
      await expect(createCli(join(cwd, '.hammerkit.yaml'), environment, scope)).rejects.toThrow(
        `unable to resolve ${repo.url} at HEAD`
      )
    })
  })
})
