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
})
