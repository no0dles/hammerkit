import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../executer/environment-mock'
import { createParseContext } from './schema-parser'
import { ParseError } from './parse-error'

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
})
