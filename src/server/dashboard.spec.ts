import { IncomingMessage, ServerResponse } from 'http'
import { Readable } from 'stream'
import { handleDashboard } from './dashboard'
import { RunExecutor, RunRegistry } from './runs'
import { serverConfigSchema } from './server-config'

const ISS = 'https://idp.corp'
const alice = { iss: ISS, sub: 'alice', groups: [], claims: {} }
const bob = { iss: ISS, sub: 'bob', groups: [], claims: {} }

const config = serverConfigSchema.parse({
  listen: { port: 0 },
  issuers: [{ issuer: ISS, audience: 'hammerkit' }],
  runs: { env: { allow: ['PATH'] } },
  accounts: {},
  entitlements: [
    { subject: { iss: ISS, sub: 'alice' }, repos: ['github.com/corp/*'], builds: 'run' },
    { subject: { iss: ISS, sub: 'bob' }, repos: ['github.com/corp/*'], builds: 'run' },
  ],
})

const spec = (tasks: string[]) => ({
  definition: 'sha256:' + 'a'.repeat(64),
  tasks,
  accounts: [],
  source: { type: 'ref' as const, repo: 'github.com/corp/shop', ref: 'main', commit: 'c'.repeat(40) },
  options: {},
})

async function open(registry: RunRegistry, principal: typeof alice, path: string) {
  const req = Object.assign(Readable.from([]), { method: 'GET', headers: {} }) as unknown as IncomingMessage
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead: (code: number, sent: Record<string, string>) => {
      status = code
      headers = sent
    },
    end: (text?: string) => (body = text ?? ''),
  } as unknown as ServerResponse
  await handleDashboard(
    { config, registry, sign: (value) => `signed:${value.length}`, log: () => undefined, now: () => Date.now() },
    principal,
    req,
    res,
    new URL(path, 'http://hammerkit.run.test')
  )
  return { status, headers, body }
}

describe('dashboard pages', () => {
  it('shows the tasks and the log of a run to its owner, with what the tasks printed made harmless', async () => {
    const executor: RunExecutor = {
      execute: async (run, { emit }) => {
        emit({ type: 'task', task: 'build', state: 'running' })
        emit({ type: 'log', task: 'build', stream: 'stdout', text: 'compiled <b>12</b> files' })
        emit({ type: 'log', task: 'build', stream: 'stderr', text: 'warn \u001b[2J ‮ reversed' })
        emit({ type: 'task', task: 'build', state: 'failed', exitCode: 2 })
        throw new Error('build failed')
      },
    }
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec(['build']))
    for (let i = 0; i < 100 && registry.get(alice, run.id)?.state !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const page = await open(registry, alice, `/runs/${run.id}`)
    expect(page.status).toBe(200)
    // a run that ended does not reload
    expect(page.headers.refresh).toBeUndefined()
    expect(page.body).toContain('<span class="state failed">failed</span>')
    expect(page.body).toContain('<td data-label="Exit">2</td>')
    expect(page.body).toContain('<span class="stdout"><b>[build]</b> compiled &#60;b&#62;12&#60;/b&#62; files</span>')
    expect(page.body).toContain('warn ?[2J ? reversed')
    expect(page.body).not.toContain('\u001b')
    expect(page.body).not.toContain('‮')

    const one = await open(registry, alice, `/runs/${run.id}?task=build`)
    expect(one.body).toContain('<span class="stdout">compiled')
    // a task it does not have shows all of it
    expect((await open(registry, alice, `/runs/${run.id}?task=nope`)).body).toContain('<b>[build]</b>')

    // a run of somebody else is not there for bob
    expect((await open(registry, bob, `/runs/${run.id}`)).status).toBe(404)
  })

  it('lists the runs of the caller, filtered by state, kind and text', async () => {
    const registry = new RunRegistry({ executor: { execute: () => new Promise(() => undefined) }, maxConcurrent: 1 })
    const build = registry.submit(alice, spec(['build']))
    const lint = registry.submit(alice, spec(['lint']))
    const bobs = registry.submit(bob, spec(['secret-task']))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const all = await open(registry, alice, '/runs')
    expect(all.body).toContain(build.id)
    expect(all.body).toContain(lint.id)
    expect(all.body).toContain('1. in the queue')
    expect(all.body).not.toContain(bobs.id)
    expect(all.body).not.toContain('secret-task')
    const queued = await open(registry, alice, '/runs?state=queued')
    expect(queued.body).not.toContain(build.id)
    expect(queued.body).toContain(lint.id)
    const text = await open(registry, alice, '/runs?q=LINT')
    expect(text.body).toContain(lint.id)
    expect(text.body).not.toContain(build.id)
    expect((await open(registry, alice, '/runs?kind=services')).body).toContain(
      'No runs the server keeps are like that'
    )
    // a filter it does not know shows everything, never an error page
    expect((await open(registry, alice, '/runs?state=%3Cx%3E')).status).toBe(200)

    const overview = await open(registry, alice, '/')
    expect(overview.headers.refresh).toBe('10')
    expect(overview.body).toContain('Places <small>1 of 1 taken')
    expect(overview.body).toContain('a run of somebody else')
    expect(overview.body).toContain('waits: no free place, 1 of 1 taken')
  })
})
