import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../executer/environment-mock'
import { createParseContext } from './schema-parser'
import { parseReferences } from './reference-parser'
import { getWorkContext } from './work-scope-parser'
import { WorkScope } from '../executer/work-scope'
import { isAskedByName } from '../planner/work-tree'

describe('tasks named together', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-named-'))
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const buildFile = `services:
  db:
    image: postgres:16
    healthcheck:
      cmd: pg_isready
    init: db-init
tasks:
  db-init:
    image: postgres:16
    cmds: [psql -c 'select 1']
  build:
    cmds: [echo build]
  lint:
    cmds: [echo lint]
`

  async function plan(scope: WorkScope) {
    const env = environmentMock(scratch)
    const file = join(scratch, '.hammerkit.yaml')
    writeFileSync(file, buildFile)
    const { ctx, scope: parsed } = await createParseContext(file, env)
    return getWorkContext(await parseReferences(ctx, parsed, env), scope, env)
  }

  it('counts each named task as asked for by name, so a named init starts its service', async () => {
    const tree = await plan({ taskNames: ['db-init', 'build'], environmentName: null })
    expect(tree.requested?.sort()).toEqual(['build', 'db-init'])
    expect(isAskedByName(tree, 'db-init')).toBe(true)
    expect(isAskedByName(tree, 'build')).toBe(true)
    expect(tree.services['db'].requiredBy.map((item) => item.name)).toContain('db-init')
  })

  it('counts a task a label selects with others as not asked for by name', async () => {
    const tree = await plan({ filterLabels: {}, excludeLabels: {}, environmentName: null })
    expect(isAskedByName(tree, 'db-init')).toBe(false)
    expect(tree.services['db'].requiredBy.map((item) => item.name)).not.toContain('db-init')
  })

  it('refuses a name that is no task', async () => {
    await expect(plan({ taskNames: ['build', 'db'], environmentName: null })).rejects.toThrow('no task named db')
  })
})
