import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { environmentMock } from '../executer/environment-mock'
import { calculateChecksum } from './calculate-checksum'

describe('calculateChecksum', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-checksum-'))
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('returns the sha1 of the file contents', async () => {
    const env = environmentMock(scratch)
    const file = join(scratch, 'a.txt')
    writeFileSync(file, 'hello world')

    const expected = createHash('sha1').update('hello world').digest('hex')
    expect(await calculateChecksum(env, file)).toBe(expected)
  })

  it('is deterministic and content-sensitive', async () => {
    const env = environmentMock(scratch)
    const file = join(scratch, 'a.txt')

    writeFileSync(file, 'one')
    const first = await calculateChecksum(env, file)
    expect(await calculateChecksum(env, file)).toBe(first)

    writeFileSync(file, 'two')
    expect(await calculateChecksum(env, file)).not.toBe(first)
  })
})
