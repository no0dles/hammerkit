import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../executer/environment-mock'
import { read, write } from './read-build-file'

describe('read-build-file', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-read-'))
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  describe('read', () => {
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

    it('rethrows non-Error throws from the yaml parser unchanged', async () => {
      // Stub yaml.parse to throw a non-Error value so the `else throw e` branch
      // in read() is exercised (the wrap-with-message branch only handles Error).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = require('yaml')
      const original = yaml.parse
      yaml.parse = () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'a plain string'
      }
      try {
        const env = environmentMock(scratch)
        const file = join(scratch, '.hammerkit.yaml')
        writeFileSync(file, 'x: 1\n')
        await expect(read(file, env)).rejects.toBe('a plain string')
      } finally {
        yaml.parse = original
      }
    })
  })

  describe('write', () => {
    it('serializes the value as yaml via the environment file context', async () => {
      const env = environmentMock(scratch)
      await write(join(scratch, 'out.yaml'), { tasks: { hi: { cmds: ['echo hi'] } } }, env)
      expect(readFileSync(join(scratch, 'out.yaml'), 'utf8')).toMatch(/tasks:\n\s+hi:\n\s+cmds:\n\s+- echo hi/)
    })
  })
})
