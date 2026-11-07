import { IncomingMessage, ServerResponse } from 'http'
import { Readable } from 'stream'
import type { Capacity, CapacityReader } from './capacity'
import { DashboardContext, handleDashboard } from './dashboard'
import type { DefinitionStore, DefinitionVersion } from './definitions'
import type { TaskPlan } from './plan'
import { ProposalRegistry } from './proposals'
import { RunExecutor, RunRegistry } from './runs'
import { ServerConfig, serverConfigSchema } from './server-config'

const ISS = 'https://idp.corp'
const person = (sub: string) => ({ iss: ISS, sub, groups: [], claims: {} })
const alice = person('alice')
const bob = person('bob')
const carol = person('carol')

const makeConfig = (activity: 'everyone' | 'involved') =>
  serverConfigSchema.parse({
    listen: { port: 0 },
    issuers: [{ issuer: ISS, audience: 'hammerkit' }],
    runs: { env: { allow: ['PATH'] }, activity },
    accounts: { 'op-prod': { providers: {} } },
    entitlements: [
      {
        subject: { iss: ISS, sub: 'alice' },
        repos: ['github.com/corp/*'],
        builds: 'run',
        accounts: { 'op-prod': 'request' },
      },
      { subject: { iss: ISS, sub: 'bob' }, repos: ['github.com/corp/*'], builds: 'run' },
      {
        subject: { iss: ISS, sub: 'carol' },
        repos: ['github.com/corp/*'],
        builds: 'publish',
        accounts: { 'op-prod': 'use' },
      },
    ],
  })

const spec = (tasks: string[], accounts: string[] = []) => ({
  definition: 'sha256:' + 'a'.repeat(64),
  tasks,
  accounts,
  source: { type: 'ref' as const, repo: 'github.com/corp/shop', ref: 'main', commit: 'c'.repeat(40) },
  options: {},
})

const plan = (cmd: string): TaskPlan => ({
  kind: 'task',
  runtime: 'docker',
  image: 'node:24',
  cmds: [cmd],
  deps: [],
  needs: [],
  accounts: [],
  secrets: [],
  mounts: [],
  ports: [],
  generates: [],
  flags: [],
})

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(check()).toBe(true)
}

interface Opened {
  status: number
  headers: Record<string, string>
  body: string
}

async function open(
  context: Omit<DashboardContext, 'sign' | 'log'> & { config: ServerConfig },
  principal: typeof alice,
  path: string,
  form?: Record<string, string>
): Promise<Opened> {
  const text = form ? new URLSearchParams(form).toString() : ''
  const req = Object.assign(Readable.from(form ? [Buffer.from(text)] : []), {
    method: form ? 'POST' : 'GET',
    headers: {},
  }) as unknown as IncomingMessage
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead: (code: number, sent: Record<string, string>) => {
      status = code
      headers = sent
    },
    end: (sent?: string) => (body = sent ?? ''),
  } as unknown as ServerResponse
  await handleDashboard(
    { sign: (value) => `signed:${Buffer.from(value).toString('base64url')}`, log: () => undefined, ...context },
    principal,
    req,
    res,
    new URL(path, 'http://hammerkit.run.test')
  )
  return { status, headers, body }
}

const csrfOf = (page: Opened) => /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] as string

describe('dashboard pages', () => {
  it('shows the tasks and the log of a run to its owner, with what the tasks printed made harmless', async () => {
    const executor: RunExecutor = {
      execute: async (run, { emit }) => {
        emit({ type: 'task', task: 'build', state: 'running' })
        emit({ type: 'log', task: 'build', stream: 'stdout', text: 'compiled <b>12</b> files' })
        emit({ type: 'log', task: 'build', stream: 'stderr', text: 'warn \u001b[2J ‮ reversed' })
        emit({ type: 'log', task: 'db', stream: 'stdout', text: 'database system is ready' })
        emit({ type: 'task', task: 'build', state: 'failed', exitCode: 2 })
        throw new Error('build failed')
      },
    }
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, { ...spec(['build']), plan: { build: plan('npm run build') } })
    await until(() => registry.get(alice, run.id)?.state === 'failed')
    const context = { config: makeConfig('everyone'), registry }
    const page = await open(context, alice, `/runs/${run.id}`)
    expect(page.status).toBe(200)
    // a run that ended does not reload
    expect(page.headers.refresh).toBeUndefined()
    expect(page.body).toContain('<span class="state failed">failed</span>')
    expect(page.body).toContain('<td data-label="Exit">2</td>')
    expect(page.body).toContain('<span class="stdout"><b>[build]</b> compiled &#60;b&#62;12&#60;/b&#62; files</span>')
    expect(page.body).toContain('warn ?[2J ? reversed')
    expect(page.body).not.toContain('\u001b')
    expect(page.body).not.toContain('‮')
    expect(page.body).toContain('$ npm run build')
    // a service's lines can be picked as a task's
    expect(page.body).toContain('?task=db#log')

    const one = await open(context, alice, `/runs/${run.id}?task=build`)
    expect(one.body).toContain('<span class="stdout">compiled')
    // a task it does not have shows all of it
    expect((await open(context, alice, `/runs/${run.id}?task=nope`)).body).toContain('<b>[build]</b>')

    // all of it, a search in it, and a file of it
    const whole = await open(context, alice, `/runs/${run.id}/log?grep=READY`)
    expect(whole.body).toContain('<mark>database system is ready</mark>')
    const file = await open(context, alice, `/runs/${run.id}/log.txt?task=build`)
    expect(file.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(file.headers['content-disposition']).toBe(`attachment; filename="${run.id}-build.log"`)
    expect(file.body).toBe('compiled <b>12</b> files\nwarn \u001b[2J ‮ reversed\n')

    // bob sees that it failed and how long it took, never why or its log
    const other = await open(context, bob, `/runs/${run.id}`)
    expect(other.status).toBe(200)
    expect(other.body).toContain('<span class="state failed">failed</span>')
    expect(other.body).not.toContain('build failed')
    expect(other.body).not.toContain('compiled')
    expect(other.body).not.toContain('npm run build')
    expect((await open(context, bob, `/runs/${run.id}/log`)).status).toBe(404)
    expect((await open(context, bob, `/runs/${run.id}/log.txt`)).status).toBe(404)
    // with involved, a run of somebody else is not there for bob
    expect((await open({ ...context, config: makeConfig('involved') }, bob, `/runs/${run.id}`)).status).toBe(404)
  })

  it('lists the runs, filtered by whose, state, kind and text, with how long they waited and ran', async () => {
    const registry = new RunRegistry({ executor: { execute: () => new Promise(() => undefined) }, maxConcurrent: 1 })
    const build = registry.submit(alice, spec(['build']))
    await until(() => registry.get(alice, build.id)?.state === 'running')
    const lint = registry.submit(alice, spec(['lint']))
    const bobs = registry.submit(bob, spec(['secret-task']))
    const involved = { config: makeConfig('involved'), registry }
    const all = await open(involved, alice, '/runs')
    expect(all.body).toContain(build.id)
    expect(all.body).toContain(lint.id)
    expect(all.body).toContain('1. in the queue')
    expect(all.body).not.toContain(bobs.id)
    expect(all.body).not.toContain('secret-task')
    expect(all.body).toContain('data-label="Waited"')
    const queued = await open(involved, alice, '/runs?state=queued')
    expect(queued.body).not.toContain(build.id)
    expect(queued.body).toContain(lint.id)
    const text = await open(involved, alice, '/runs?q=LINT')
    expect(text.body).toContain(lint.id)
    expect(text.body).not.toContain(build.id)
    expect((await open(involved, alice, '/runs?kind=services')).body).toContain(
      'No runs the server keeps are like that'
    )
    // a filter it does not know shows everything, never an error page
    expect((await open(involved, alice, '/runs?state=%3Cx%3E')).status).toBe(200)

    const overview = await open(involved, alice, '/')
    expect(overview.headers.refresh).toBe('10')
    expect(overview.body).toContain('Places <small>1 of 1 taken')
    expect(overview.body).toContain('a run of somebody else')
    expect(overview.body).toContain('waits: no free place, 1 of 1 taken')

    // with everyone, the runs of bob are there, with whose they are
    const everyone = { config: makeConfig('everyone'), registry }
    const shared = await open(everyone, alice, '/runs')
    expect(shared.body).toContain(bobs.id)
    expect(shared.body).toContain('of bob')
    expect((await open(everyone, alice, '/runs?who=mine')).body).not.toContain(bobs.id)
    expect((await open(everyone, alice, '/runs?q=bob')).body).toContain(bobs.id)
    expect((await open(everyone, alice, '/')).body).toContain(`<a href="/runs/${bobs.id}">`)
  })

  it('shows what the past runs of each task took', async () => {
    let n = 0
    const registry = new RunRegistry({
      executor: {
        execute: async (run, { emit }) => {
          n++
          emit({ type: 'task', task: 'test', state: 'running' })
          emit({ type: 'task', task: 'test', state: n === 2 ? 'failed' : 'succeeded', durationMs: n * 1000 })
          if (n === 2) {
            throw new Error('test failed')
          }
        },
      },
    })
    for (const who of [alice, bob, alice]) {
      const run = registry.submit(who, spec(['test']))
      await until(() => ['succeeded', 'failed'].includes(registry.peek(run.id)?.state ?? ''))
    }
    const page = await open({ config: makeConfig('everyone'), registry }, alice, '/tasks')
    expect(page.body).toContain('<code>test</code></td><td>github.com/corp/shop</td>')
    expect(page.body).toContain('<td class="num" data-label="Runs">3</td><td class="num" data-label="Failed">1</td>')
    expect(page.body).toContain('<td class="num" data-label="Median">2s</td><td class="num" data-label="90%">3s</td>')
    // only her own two with involved
    const own = await open({ config: makeConfig('involved'), registry }, alice, '/tasks')
    expect(own.body).toContain('<td class="num" data-label="Runs">2</td>')
  })

  it('lets who uses an account approve a run, and who may publish publish a version', async () => {
    const registry = new RunRegistry({ executor: { execute: async () => undefined } })
    const published: string[] = []
    const definitions = {
      publish: async (bundle: { entry: string }) => {
        published.push(bundle.entry)
      },
    } as unknown as DefinitionStore
    const proposals = new ProposalRegistry()
    const version = {
      hash: 'sha256:' + 'b'.repeat(64),
      entry: '.hammerkit.yaml',
      tasks: ['deploy'],
      services: [],
      accounts: ['op-prod'],
      plan: { deploy: plan('./deploy.sh <prod>') },
    } as unknown as DefinitionVersion
    proposals.propose(version, { entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': 'tasks: <x>' } }, bob, [
      'op-prod',
    ])
    const waiting = registry.submit(
      alice,
      { ...spec(['deploy'], ['op-prod']), plan: { deploy: plan('./deploy.sh') } },
      ['op-prod']
    )
    const context = { config: makeConfig('everyone'), registry, proposals, definitions }

    const mine = await open(context, carol, '/approvals')
    expect(mine.body).toContain('Approvals <span class="badge">2</span>')
    expect(mine.body).toContain(`<a href="/runs/${waiting.id}">`)
    expect(mine.body).toContain(`/approvals/versions/${version.hash}`)
    const file = await open(context, carol, `/approvals/versions/${version.hash}`)
    expect(file.body).toContain('tasks: &#60;x&#62;')
    expect(file.body).toContain('$ ./deploy.sh &#60;prod&#62;')
    // alice asked, she does not decide; bob proposed, he sees his version but not its buttons
    const asked = await open(context, alice, '/approvals')
    expect(asked.body).toContain('Your runs that wait')
    expect(asked.body).not.toContain('/approve"')
    expect((await open(context, bob, `/approvals/versions/${version.hash}`)).body).not.toContain('/approve"')

    const csrf = csrfOf(mine)
    expect((await open(context, carol, `/approvals/runs/${waiting.id}/approve`)).status).toBe(405)
    expect((await open(context, carol, `/approvals/runs/${waiting.id}/approve`, { csrf: 'forged' })).status).toBe(403)
    expect(
      (
        await open(context, alice, `/approvals/runs/${waiting.id}/approve`, {
          csrf: csrfOf(await open(context, alice, `/runs/${waiting.id}`)),
        })
      ).status
    ).toBe(404)
    const approved = await open(context, carol, `/approvals/runs/${waiting.id}/approve`, { csrf, back: '/approvals' })
    expect(approved.status).toBe(303)
    await until(() => registry.peek(waiting.id)?.state === 'succeeded')

    const rejected = await open(context, carol, `/approvals/versions/${version.hash}/reject`, {
      csrf,
      reason: 'not now',
    })
    expect(rejected.status).toBe(303)
    expect(proposals.get(version.hash)).toMatchObject({ state: 'rejected', reason: 'not now' })
    expect(published).toEqual([])
  })

  it('shows the capacity of the machines, and whose namespaces are where it may', async () => {
    const registry = new RunRegistry({ executor: { execute: () => new Promise(() => undefined) } })
    const run = registry.submit(bob, spec(['build']))
    const reader: CapacityReader = {
      read: async (): Promise<Capacity> => ({
        backend: 'kubernetes',
        at: new Date().toISOString(),
        machines: { count: 3, allocatable: { cpu: 12, memory: 48 * 1024 ** 3 }, used: { cpu: 3.5 } },
        runs: { requested: { cpu: 2.25, memory: 4 * 1024 ** 3 }, used: { cpu: 1.5, memory: 2 * 1024 ** 3 }, pods: 4 },
        groups: [
          {
            name: 'hk-0123456789abcdef',
            kind: 'caller',
            owner: { iss: ISS, sub: 'bob' },
            pods: 4,
            requested: { cpu: 2.25, memory: 4 * 1024 ** 3 },
            quota: { cpu: 8, memory: 16 * 1024 ** 3 },
            used: { cpu: 1.5, memory: 2 * 1024 ** 3 },
          },
        ],
        problems: ['the nodes: not shown, the server may not list nodes'],
      }),
    }
    const page = await open({ config: makeConfig('everyone'), registry, capacity: reader }, alice, '/capacity')
    expect(page.body).toContain('12 cores on 3 nodes')
    expect(page.body).toContain('runs requested 2.25')
    expect(page.body).toContain('<code>hk-0123456789abcdef</code>')
    expect(page.body).toContain('<td>bob</td>')
    expect(page.body).toContain('8 CPU · 16 GiB')
    expect(page.body).toContain('the server may not list nodes')
    expect((await open({ config: makeConfig('everyone'), registry, capacity: reader }, alice, '/')).body).toContain(
      'Capacity <small>'
    )
    // with involved, alice does not learn whose the namespace is
    const involved = await open({ config: makeConfig('involved'), registry, capacity: reader }, alice, '/capacity')
    expect(involved.body).not.toContain('<td>bob</td>')
    expect(run.id).toMatch(/^run_/)
  })
})
