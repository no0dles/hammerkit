import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../executer/environment-mock'
import { read } from './read-build-file'

describe('read build file', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-read-'))
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('parses a yaml build file into an object', async () => {
    const env = environmentMock(scratch)
    const file = join(scratch, '.hammerkit.yaml')
    writeFileSync(file, 'tasks:\n  build:\n    cmds:\n      - echo hi\n')

    const result = await read(file, env)
    expect(result.tasks.build.cmds).toEqual(['echo hi'])
  })

  it('throws a readable error for a missing file', async () => {
    const env = environmentMock(scratch)
    await expect(read(join(scratch, 'does-not-exist.yaml'), env)).rejects.toThrow(/unable to read/)
  })

  it('throws a readable error for malformed yaml', async () => {
    const env = environmentMock(scratch)
    const file = join(scratch, '.hammerkit.yaml')
    // tabs are not valid yaml indentation
    writeFileSync(file, 'tasks:\n\t- build\n')

    await expect(read(file, env)).rejects.toThrow(/unable to parse/)
  })
})
