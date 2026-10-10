import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('json-schema', () => {
  let originalCwd: string
  let tmpDir: string

  beforeAll(() => {
    originalCwd = process.cwd()
  })

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'json-schema-'))
    process.chdir(tmpDir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('writes the build file json schema into the current working directory', async () => {
    await import('./json-schema')

    const schemaPath = join(tmpDir, 'build.schema.gen.json')
    expect(existsSync(schemaPath)).toBe(true)

    const parsed = JSON.parse(readFileSync(schemaPath, 'utf8'))
    expect(parsed).toBeTypeOf('object')
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed).length).toBeGreaterThan(0)
  })
})
