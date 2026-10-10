import { runProgram } from '../run-program'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { createGitRepo, GitRepo, isolateHammerkitHome } from '../testing/git-repo'

describe('hammerkit includes pull', () => {
  let repo: GitRepo
  let home: ReturnType<typeof isolateHammerkitHome>

  beforeEach(() => {
    home = isolateHammerkitHome()
    repo = createGitRepo()
  })
  afterEach(() => {
    repo.remove()
    home.restore()
  })

  const buildFile = (ref: string) => ({
    '.hammerkit.yaml': ['includes:', '  shared:', `    git: ${repo.url}`, `    ref: ${ref}`, ''].join('\n'),
  })

  async function pull(ref: string, files: { [name: string]: string } = {}): Promise<string> {
    const out = memoryStream()
    await createTestCase('includes-pull', { ...buildFile(ref), ...files }).setup(async (_cwd, environment) => {
      environment.stdout = out.stream
      await runProgram(environment, ['hammerkit', 'includes', 'pull'], true)
    })
    return out.read()
  }

  it('picks up new commits of a branch and says which', async () => {
    const first = repo.commit({ 'build.yaml': 'tasks: {}' })
    expect(await pull('main')).toContain(`at main: fetched ${first.slice(0, 12)}`)

    const second = repo.commit({ 'build.yaml': 'tasks: {}\n# changed' })

    expect(await pull('main')).toContain(`at main: ${first.slice(0, 12)} -> ${second.slice(0, 12)}`)
    expect(await pull('main')).toContain(`up to date at ${second.slice(0, 12)}`)
  })

  it('leaves a commit SHA alone', async () => {
    const first = repo.commit({ 'build.yaml': 'tasks: {}' })
    await pull(first)
    repo.commit({ 'build.yaml': 'tasks: {}\n# changed' })

    expect(await pull(first)).toContain(`pinned to ${first.slice(0, 12)}`)
  })

  it('fetches a repository named twice once', async () => {
    repo.commit({ 'build.yaml': 'tasks: {}' })
    const files = {
      '.hammerkit.yaml': [
        'includes:',
        `  one: { git: ${repo.url}, ref: main }`,
        `  two: { git: ${repo.url}, ref: main }`,
        '',
      ].join('\n'),
    }

    const output = await pull('main', files)

    expect(output.trim().split('\n')).toHaveLength(1)
  })

  it('says so when there is nothing to pull', async () => {
    const out = memoryStream()
    await createTestCase('includes-pull-none', { '.hammerkit.yaml': 'tasks: {}\n' }).setup(
      async (_cwd, environment) => {
        environment.stdout = out.stream
        await runProgram(environment, ['hammerkit', 'includes', 'pull'], true)
      }
    )

    expect(out.read()).toBe('no remote includes\n')
  })

  it('is undone by clean --cache, so the next run fetches again', async () => {
    repo.commit({ 'build.yaml': 'tasks: {}' })
    await pull('main')
    const second = repo.commit({ 'build.yaml': 'tasks: {}\n# changed' })

    await createTestCase('includes-pull-clean', buildFile('main')).setup(async (_cwd, environment) => {
      await runProgram(environment, ['hammerkit', 'clean', '--cache'], true)
    })

    expect(await pull('main')).toContain(`at main: fetched ${second.slice(0, 12)}`)
  })

  it('fails and names the repository when it cannot be fetched', async () => {
    repo.commit({ 'build.yaml': 'tasks: {}' })
    await pull('main')
    repo.remove()

    await expect(pull('main')).rejects.toThrow('Includes pull was not successful')
  })
})
