import colors from 'colors'
import { runProgram } from '../run-program'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { createGitRepo, GitRepo, isolateHammerkitHome } from '../testing/git-repo'
import { TaskDefinition } from './describe-task'

describe('explain --definition', () => {
  let repo: GitRepo
  let home: ReturnType<typeof isolateHammerkitHome>
  let commit: string

  beforeEach(() => {
    home = isolateHammerkitHome()
    repo = createGitRepo()
    commit = repo.commit({
      'catalog/npm/build.yaml': [
        'envs:',
        '  NODE_VERSION: 24',
        '  MODE: fast',
        'tasks:',
        '  install:',
        '    description: install the dependencies',
        '    image: node:${NODE_VERSION}-alpine',
        '    src: [package.json]',
        '    generates: [node_modules]',
        '    envs:',
        '      CI: "true"',
        '    cmds: [npm ci]',
        '',
      ].join('\n'),
    })
    repo.tag('v1')
  })
  afterEach(() => {
    repo.remove()
    home.restore()
  })

  async function explain(files: { [name: string]: string }, args: string[]): Promise<string> {
    const out = memoryStream()
    await createTestCase('explain-definition', files).setup(async (_cwd, environment) => {
      environment.stdout = out.stream
      await runProgram(environment, ['hammerkit', 'explain', '--definition', ...args], true)
    })
    return out.read()
  }

  const consumer = (extra: string[] = []) => ({
    '.hammerkit.yaml': [
      'envs:',
      '  GREETING: hello',
      'includes:',
      '  npm:',
      `    git: ${repo.url}`,
      '    ref: v1',
      '    path: catalog/npm',
      '    with:',
      '      NODE_VERSION: 22',
      'tasks:',
      '  own:',
      '    cmds: [echo $GREETING]',
      '    envs:',
      '      FROM_SHELL: $HOME',
      ...extra,
      '',
    ].join('\n'),
  })

  it('shows the resolved definition of an included task and where it came from', async () => {
    const definitions: TaskDefinition[] = JSON.parse(await explain(consumer(), ['npm:install', '--json']))

    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({
      name: 'npm:install',
      type: 'container',
      description: 'install the dependencies',
      image: 'node:22-alpine',
      src: ['package.json'],
      generates: ['node_modules'],
      cmds: ['npm ci'],
      source: { file: 'catalog/npm/build.yaml', includedAs: 'npm', git: repo.url, ref: 'v1', commit },
    })
  })

  it('names where each env value was declared', async () => {
    const [definition]: TaskDefinition[] = JSON.parse(await explain(consumer(), ['npm:install', '--json']))

    expect(definition.envs).toEqual([
      { name: 'CI', value: 'true', origin: 'task' },
      { name: 'NODE_VERSION', value: '22', origin: 'input' },
      { name: 'MODE', value: 'fast', origin: 'build-file' },
    ])
  })

  it('names the envs an extending task carries from the task it extends', async () => {
    const files = consumer(['  build:', '    extend: npm:install', '    cmds: [npm run build]'])

    const definitions: TaskDefinition[] = JSON.parse(await explain(files, ['build', '--json']))
    const build = definitions.find((definition) => definition.name === 'build')

    expect(build?.cmds).toEqual(['npm ci', 'npm run build'])
    expect(build?.envs).toEqual(
      expect.arrayContaining([
        { name: 'NODE_VERSION', value: '22', origin: 'extend' },
        { name: 'CI', value: 'true', origin: 'extend' },
      ])
    )
  })

  it('lists variables taken from the environment without their values', async () => {
    const definitions: TaskDefinition[] = JSON.parse(await explain(consumer(), ['own', '--json']))

    expect(definitions[0].envReferences).toEqual([{ name: 'FROM_SHELL', from: 'HOME', available: true }])
    expect(JSON.stringify(definitions)).not.toContain(process.env.HOME ?? 'no-home')
    expect(definitions[0].source).toMatchObject({ file: '.hammerkit.yaml', includedAs: '', git: null })
  })

  it('prints the definition as text', async () => {
    const output = colors.strip(await explain(consumer(), ['npm:install']))

    expect(output).toContain('• npm:install')
    expect(output).toContain(`defined in: catalog/npm/build.yaml of ${repo.url} at v1 (commit ${commit.slice(0, 12)})`)
    expect(output).toContain('included as: npm')
    expect(output).toContain('image: node:22-alpine')
    expect(output).toContain('env NODE_VERSION: 22')
    expect(output).toContain('input of include npm')
  })
})
