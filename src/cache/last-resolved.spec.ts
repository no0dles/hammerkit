import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Environment } from '../executer/environment'
import { getLastResolvedFile, readLastResolvedRecord, writeLastResolvedRecord } from './last-resolved'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'

describe('the last-resolved record of a task', () => {
  let outside: string
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'hammerkit-last-resolved-'))
    writeFileSync(join(outside, 'keep.txt'), 'the server keeps this')
  })
  afterEach(() => rmSync(outside, { recursive: true, force: true }))

  const files = {
    '.hammerkit.yaml': { tasks: { build: { cmds: ['node --version'], src: ['input.txt'] } } },
    'input.txt': 'one\n',
  }
  const write = (environment: Environment, item: any) =>
    writeLastResolvedRecord(environment, item, {
      description: getWorkTaskCacheDescription(item),
      stats: { created: new Date(), files: {} },
    })

  it('is written into the project on a machine, and read back', async () => {
    const t = createTestCase('last-resolved-written', files)
    await t.setup(async (cwd, environment) => {
      const item = (await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })).task('build')
      await write(environment, item)
      expect(await readLastResolvedRecord(environment, item)).toMatchObject({ taskName: 'build' })
    })
  })

  it('is not written through a link the project holds, wherever it points', async () => {
    const t = createTestCase('last-resolved-link', files)
    await t.setup(async (cwd, environment) => {
      const item = (await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })).task('build')
      const file = getLastResolvedFile(item)
      // the record's own name a link to a file of the machine
      mkdirSync(join(cwd, '.hammerkit', 'last-resolved'), { recursive: true })
      symlinkSync(join(outside, 'keep.txt'), file)
      await write(environment, item)
      expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('the server keeps this')
      // `.hammerkit` itself a link to a folder of the machine
      rmSync(join(cwd, '.hammerkit'), { recursive: true, force: true })
      symlinkSync(outside, join(cwd, '.hammerkit'), 'junction')
      await write(environment, item)
      expect(existsSync(join(outside, 'last-resolved'))).toBe(false)
    })
  })

  it('is not written on a server, which does not own the project', async () => {
    const t = createTestCase('last-resolved-hosted', files)
    await t.setup(async (cwd, environment) => {
      const item = (await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })).task('build')
      await write({ ...environment, hosted: {} } as unknown as Environment, item)
      expect(existsSync(getLastResolvedFile(item))).toBe(false)
    })
  })
})
