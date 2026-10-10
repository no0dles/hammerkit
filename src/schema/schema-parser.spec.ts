import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../executer/environment-mock'
import { createParseContext } from './schema-parser'
import { ParseError } from './parse-error'
import { createGitRepo, GitRepo, isolateHammerkitHome } from '../testing/git-repo'

describe('createParseContext', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-schema-'))
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  function writeBuildFile(content: string): string {
    const file = join(scratch, '.hammerkit.yaml')
    writeFileSync(file, content)
    return file
  }

  it('parses a valid build file', async () => {
    const env = environmentMock(scratch)
    const file = writeBuildFile('tasks:\n  build:\n    cmds:\n      - echo hi\n')

    const { scope } = await createParseContext(file, env)
    expect(scope.schema.tasks?.build).toBeDefined()
  })

  it('rejects an unknown top-level key (strict schema)', async () => {
    const env = environmentMock(scratch)
    const file = writeBuildFile('bogus: true\ntasks:\n  build:\n    cmds:\n      - echo hi\n')

    await expect(createParseContext(file, env)).rejects.toBeInstanceOf(ParseError)
  })

  it('rejects a task with an invalid command shape', async () => {
    const env = environmentMock(scratch)
    const file = writeBuildFile('tasks:\n  build:\n    cmds: 42\n')

    await expect(createParseContext(file, env)).rejects.toBeInstanceOf(ParseError)
  })

  it('resolves a reference to another build file', async () => {
    const env = environmentMock(scratch)
    const sub = join(scratch, 'sub')
    writeFileSync(
      join(scratch, '.hammerkit.yaml'),
      'references:\n  lib: sub\ntasks:\n  build:\n    cmds:\n      - echo root\n'
    )
    // create the referenced build file
    mkdirSync(sub)
    writeFileSync(join(sub, '.hammerkit.yaml'), 'tasks:\n  lib-build:\n    cmds:\n      - echo lib\n')

    const { scope } = await createParseContext(join(scratch, '.hammerkit.yaml'), env)
    expect(scope.references['lib']).toBeDefined()
    expect(scope.references['lib'].scope.schema.tasks?.['lib-build']).toBeDefined()
  })

  it('resolves an include (sibling build file merged under a name)', async () => {
    const env = environmentMock(scratch)
    writeFileSync(join(scratch, 'common.yaml'), 'tasks:\n  shared:\n    cmds:\n      - echo s\n')
    writeFileSync(join(scratch, '.hammerkit.yaml'), 'includes:\n  npm: common.yaml\n')
    const { scope } = await createParseContext(join(scratch, '.hammerkit.yaml'), env)
    expect(scope.references['npm']).toBeDefined()
    expect(scope.references['npm'].type).toBe('include')
    expect(scope.references['npm'].scope.schema.tasks?.['shared']).toBeDefined()
  })

  it('throws when an include and a reference share the same name', async () => {
    const env = environmentMock(scratch)
    const sub = join(scratch, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, '.hammerkit.yaml'), 'tasks:\n  x:\n    cmds:\n      - echo x\n')
    writeFileSync(join(scratch, 'inc.yaml'), 'tasks:\n  y:\n    cmds:\n      - echo y\n')
    writeFileSync(join(scratch, '.hammerkit.yaml'), 'references:\n  lib: sub\nincludes:\n  lib: inc.yaml\n')
    await expect(createParseContext(join(scratch, '.hammerkit.yaml'), env)).rejects.toThrow(/lib already exists/)
  })

  it('reuses an already-parsed build file when reached again (cache hit)', async () => {
    const env = environmentMock(scratch)
    const sub = join(scratch, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, '.hammerkit.yaml'), 'tasks:\n  s:\n    cmds:\n      - echo s\n')
    writeFileSync(join(scratch, '.hammerkit.yaml'), 'references:\n  a: sub\n  b: sub\n')

    const { ctx, scope } = await createParseContext(join(scratch, '.hammerkit.yaml'), env)
    // Both references point at sub/.hammerkit.yaml and must end up at the same
    // parsed ParseScope (the second appendBuildFile hits the ctx.files cache).
    expect(scope.references['a'].scope).toBe(scope.references['b'].scope)
    expect(Object.keys(ctx.files)).toHaveLength(2) // root + sub (sub cached on second visit)
  })

  describe('git sources', () => {
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

    const task = (name: string) => `tasks:\n  ${name}:\n    cmds:\n      - echo ${name}\n`
    const root = () => join(scratch, '.hammerkit.yaml')

    it('includes a build file from a git repository at a subpath', async () => {
      repo.commit({ 'catalog/npm/build.yaml': task('install') })
      writeFileSync(root(), `includes:\n  npm:\n    git: ${repo.url}\n    ref: main\n    path: catalog/npm\n`)

      const { scope } = await createParseContext(root(), environmentMock(scratch))

      const include = scope.references['npm']
      expect(include.type).toBe('include')
      expect(include.scope.schema.tasks?.install).toBeDefined()
      // an include runs where it is included, not in the cached checkout
      expect(include.scope.cwd).toBe(scratch)
      expect(include.scope.remote?.git).toBe(repo.url)
    })

    it('references a build file from a git repository, running in its checkout', async () => {
      repo.commit({ '.hammerkit.yaml': task('lib') })
      writeFileSync(root(), `references:\n  lib:\n    git: ${repo.url}\n`)

      const { scope } = await createParseContext(root(), environmentMock(scratch))

      const reference = scope.references['lib']
      expect(reference.type).toBe('reference')
      expect(reference.scope.schema.tasks?.lib).toBeDefined()
      expect(reference.scope.cwd).toBe(reference.scope.remote?.root)
    })

    it('resolves a remote file’s own relative includes and references within the same checkout', async () => {
      repo.commit({
        'catalog/tsc/build.yaml': `includes:\n  npm: ../npm/build.yaml\nreferences:\n  extra: ../extra\n${task(
          'build'
        )}`,
        'catalog/npm/build.yaml': task('install'),
        'catalog/extra/.hammerkit.yaml': task('extra'),
      })
      writeFileSync(root(), `includes:\n  tsc:\n    git: ${repo.url}\n    path: catalog/tsc\n`)

      const { scope } = await createParseContext(root(), environmentMock(scratch))

      const tsc = scope.references['tsc'].scope
      expect(tsc.references['npm'].scope.schema.tasks?.install).toBeDefined()
      expect(tsc.references['extra'].scope.schema.tasks?.extra).toBeDefined()
      expect(tsc.references['npm'].scope.remote?.commit).toBe(tsc.remote?.commit)
    })

    it('rejects a remote file whose relative path leaves its repository', async () => {
      repo.commit({ 'build.yaml': `includes:\n  escape: ../../outside.yaml\n` })
      writeFileSync(root(), `includes:\n  remote:\n    git: ${repo.url}\n`)

      await expect(createParseContext(root(), environmentMock(scratch))).rejects.toThrow(/points outside/)
    })

    it('rejects a subpath that leaves the repository', async () => {
      repo.commit({ 'build.yaml': task('x') })
      writeFileSync(root(), `includes:\n  remote:\n    git: ${repo.url}\n    path: ../..\n`)

      await expect(createParseContext(root(), environmentMock(scratch))).rejects.toThrow(/points outside/)
    })

    it('rejects unknown fields and option-like values in a git source', async () => {
      writeFileSync(root(), `includes:\n  remote:\n    git: ${repo.url}\n    branch: main\n`)
      await expect(createParseContext(root(), environmentMock(scratch))).rejects.toBeInstanceOf(ParseError)

      writeFileSync(root(), `includes:\n  remote:\n    git: --upload-pack=touch\n`)
      await expect(createParseContext(root(), environmentMock(scratch))).rejects.toBeInstanceOf(ParseError)

      writeFileSync(root(), `includes:\n  remote:\n    git: ${repo.url}\n    ref: --all\n`)
      await expect(createParseContext(root(), environmentMock(scratch))).rejects.toBeInstanceOf(ParseError)
    })
  })
})
