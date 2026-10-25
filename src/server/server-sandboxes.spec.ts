import { execFileSync } from 'child_process'
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { HOST_ENV_ALLOW } from '../testing/host-env'
import { TEST_WORKER } from '../testing/worker'
import { readServerConfig, ServerConfig } from './server-config'
import { RunExecutor } from './runs'
import { startServer } from './server'
import { author } from './sandboxes-api'

const REPO = 'github.com/corp/payments'

// alice keeps sandboxes; bob publishes and may not keep any; dev takes sandbox runs, ci does not
const policy = `
runs: { env: { allow: ${JSON.stringify(HOST_ENV_ALLOW)} } }
runtimes: [docker, local]
sandboxes: { runtimes: [docker, local], network: open, limits: { count: 2, bytes: 1Mi } }
secretProviders:
  echo: { command: [${JSON.stringify(process.execPath)}, -e, "process.stdout.write(process.argv[1])", "{{ref}}"] }
accounts:
  dev: { providers: { echo: { env: {} } }, source: [ref, sandbox] }
  ci: { providers: { echo: { env: {} } } }
  scm: { providers: { echo: { env: {} } } }
sources:
  - match: github.com/corp/*
    secret: { from: "echo:scm-token", account: scm }
entitlements:
  - subject: { iss: ISSUER, sub: alice }
    accounts: { dev: use, ci: use }
    repos: [github.com/corp/*]
    builds: run
    sandboxes: [{ repo: github.com/corp/*, branches: { main: pull, next: pull, 'feature/*': pull, 'agent/**': push } }]
  - subject: { iss: ISSUER, sub: carol }
    repos: [github.com/corp/*]
    builds: run
    sandboxes: [{ repo: github.com/corp/*, branches: { main: pull, next: pull, 'feature/*': pull } }]
  - subject: { iss: ISSUER, sub: bob }
    accounts: { dev: use, ci: use }
    repos: [github.com/corp/*]
    builds: publish
  - claims: { iss: ISSUER, match: { team: release } }
    sandboxes: [{ repo: github.com/corp/*, branches: { 'release/*': pull } }]
`

const buildFile = [
  'tasks:',
  '  build:',
  '    cmds: [cat input.txt]',
  '  dev:',
  '    secrets:',
  '      - { from: "echo:dev", account: dev, env: TOKEN }',
  '    cmds: [echo dev]',
  '  ci:',
  '    secrets:',
  '      - { from: "echo:ci", account: ci, env: TOKEN }',
  '    cmds: [echo ci]',
  '  path:',
  '    secrets:',
  '      - { from: "env:PATH", env: SEARCH }',
  '    cmds: [echo path]',
  '  leak:',
  '    src: [escape]',
  '    cmds: [cat escape/secret.txt]',
  '  plant:',
  // what `ln -s / rootlink` in a task does, a junction on Windows. The shell's own commands: a
  // node started by a local task, which gets no variables of the server but PATH, left neither
  // output nor link on Windows
  `    cmds: [${JSON.stringify(
    process.platform === 'win32'
      ? "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path rootlink -Value ([IO.Path]::GetPathRoot($PWD.Path)) | Out-Null; Get-ChildItem -Name"
      : 'ln -s / rootlink && ls'
  )}]`,
  '  all:',
  "    src: ['**']",
  '    cmds: [cat input.txt]',
  '',
].join('\n')

interface JsonResponse extends Response {
  json(): Promise<any>
}

interface Api {
  call: (
    method: string,
    path: string,
    options?: { sub?: string; body?: unknown; claims?: Record<string, string> }
  ) => Promise<JsonResponse>
  url: string
  // the authorization header of alice
  auth: () => string
  hash: string
  log: string[]
  // where the files of a sandbox are on the server
  files: (id: string) => string
  // the entitlements the server reads from now on
  entitle: (change: (entitlements: ServerConfig['entitlements']) => ServerConfig['entitlements']) => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('sandboxes api', () => {
  let repository: string

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: repository,
        encoding: 'utf8',
      }
    ).trim()

  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), 'hammerkit-sandbox-repository-'))
    git('init', '--quiet', '--initial-branch=main')
    writeFileSync(join(repository, 'input.txt'), 'from-main')
    git('add', '.')
    git('commit', '--quiet', '-m', 'one')
    git('tag', 'feature/v1')
    git('checkout', '--quiet', '-b', 'next')
    writeFileSync(join(repository, 'input.txt'), 'from-next')
    git('commit', '--quiet', '-am', 'two')
    git('checkout', '--quiet', 'main')
  })

  afterEach(() => rmSync(repository, { recursive: true, force: true }))

  async function withApi(name: string, executor: RunExecutor | undefined, fn: (api: Api) => Promise<void>) {
    const key = createTestKey('ES256', 'k1')
    const idp = await startTestIssuer([key])
    try {
      await createTestCase(name, {}).setup(async (cwd, env) => {
        const file = join(cwd, 'server.yaml')
        writeFileSync(
          file,
          `listen: { port: 0 }\nstorage: { directory: ${JSON.stringify(
            join(cwd, 'server-data')
          )} }\nissuers:\n  - { issuer: "${idp.url}", audience: hammerkit }\n${policy.replace(
            /ISSUER/g,
            `"${idp.url}"`
          )}`
        )
        const log: string[] = []
        const serverEnv = { ...env, processEnvs: { ...process.env } }
        const config = await readServerConfig(serverEnv, file)
        const server = await startServer(config, serverEnv, {
          log: (line) => log.push(line),
          executor,
          repos: { url: () => repository },
          worker: TEST_WORKER,
        })
        const auth = (sub = 'alice', claims: Record<string, string> = {}) =>
          `Bearer ${signToken(key, {
            ...claims,
            iss: idp.url,
            sub,
            aud: 'hammerkit',
            exp: Math.floor(Date.now() / 1000) + 300,
          })}`
        const call: Api['call'] = (method, path, options = {}) =>
          fetch(`${server.url}${path}`, {
            method,
            headers: {
              authorization: auth(options.sub, options.claims),
              ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
          }) as Promise<JsonResponse>
        try {
          const published = await call('POST', '/v1/definitions', {
            sub: 'bob',
            body: { files: { '.hammerkit.yaml': buildFile } },
          })
          expect(published.status).toBe(201)
          await fn({
            call,
            url: server.url,
            auth: () => auth(),
            hash: (await published.json()).hash,
            log,
            files: (id) => join(cwd, 'server-data', 'sandboxes', 'files', id, 'files'),
            entitle: (change) => {
              server.reload({ ...config, entitlements: change(config.entitlements) })
            },
          })
        } finally {
          await server.close()
        }
      })
    } finally {
      await idp.close()
    }
  }

  const create = (api: Api, sub = 'alice', ref = 'main') =>
    api.call('POST', '/v1/sandboxes', { sub, body: { repo: REPO, ref } })

  const runOn = (api: Api, id: string, tasks = ['build'], sub = 'alice') =>
    api.call('POST', '/v1/runs', {
      sub,
      body: { definition: api.hash, tasks, source: { type: 'sandbox', id } },
    })

  async function untilState(api: Api, id: string, states: string[]) {
    const until = Date.now() + 30_000
    let run: any
    while (Date.now() < until) {
      run = await (await api.call('GET', `/v1/runs/${id}`)).json()
      if (states.includes(run.state)) {
        return run
      }
      await sleep(20)
    }
    // where it stopped, for a failure on a machine nobody can log in to
    const logs = await (await api.call('GET', `/v1/runs/${id}/logs`)).text()
    throw new Error(
      `run ${id} never reached ${states}: ${JSON.stringify(run)}\n${logs.slice(-4000)}\n${api.log
        .slice(-20)
        .join('\n')}`
    )
  }

  it('creates, lists, moves and deletes the sandboxes of a caller', async () => {
    await withApi('sandboxes-api-lifecycle', undefined, async (api) => {
      const created = await create(api)
      expect(created.status).toBe(201)
      const sandbox = await created.json()
      const commit = git('rev-parse', 'main')
      expect(sandbox).toMatchObject({ repo: REPO, ref: 'main', commit, busy: false, run: null })
      expect(sandbox.owner).toBeUndefined()

      const list = await (await api.call('GET', '/v1/sandboxes')).json()
      expect(list.sandboxes.map((s: { id: string }) => s.id)).toEqual([sandbox.id])
      expect(list.limits).toEqual({ count: 2, bytes: 1024 ** 2 })
      expect(list.used).toEqual({ count: 1, bytes: sandbox.bytes })
      expect((await api.call('GET', `/v1/sandboxes/${sandbox.id}`)).status).toBe(200)

      // somebody else's sandbox is not there
      expect((await api.call('GET', `/v1/sandboxes/${sandbox.id}`, { sub: 'carol' })).status).toBe(404)
      expect((await api.call('DELETE', `/v1/sandboxes/${sandbox.id}`, { sub: 'carol' })).status).toBe(404)
      expect(await (await api.call('GET', '/v1/sandboxes', { sub: 'carol' })).json()).toMatchObject({ sandboxes: [] })

      const moved = await api.call('POST', `/v1/sandboxes/${sandbox.id}/fetch`, { body: { ref: 'next' } })
      expect(moved.status).toBe(200)
      expect(await moved.json()).toMatchObject({ ref: 'next', commit: git('rev-parse', 'next') })
      // a branch the caller has no type for
      expect((await api.call('POST', `/v1/sandboxes/${sandbox.id}/fetch`, { body: { ref: 'other' } })).status).toBe(403)

      expect((await api.call('DELETE', `/v1/sandboxes/${sandbox.id}`)).status).toBe(200)
      expect((await api.call('GET', `/v1/sandboxes/${sandbox.id}`)).status).toBe(404)
      expect(api.log.some((line) => line.startsWith(`sandbox create ${sandbox.id} iss=`))).toBe(true)
    })
  })

  it('needs sandboxes on an entitlement, a repository of the caller and a ref that exists', async () => {
    await withApi('sandboxes-api-refused', undefined, async (api) => {
      const bob = await create(api, 'bob')
      expect(bob.status).toBe(403)
      expect((await bob.json()).error).toBe('you are not entitled to keep sandboxes on this server')
      expect((await (await api.call('GET', '/v1/me', { sub: 'bob' })).json()).sandboxes).toEqual([])
      expect((await (await api.call('GET', '/v1/me')).json()).sandboxes).toEqual([
        {
          repo: 'github.com/corp/*',
          branches: { main: 'pull', next: 'pull', 'feature/*': 'pull', 'agent/**': 'push' },
        },
      ])
      const tag = await create(api, 'alice', 'v1')
      expect(tag.status).toBe(403)
      expect((await tag.json()).error).toMatch(/may not keep a sandbox of github.com\/corp\/payments from v1/)
      const other = await api.call('POST', '/v1/sandboxes', { body: { repo: 'github.com/other/x', ref: 'main' } })
      expect(other.status).toBe(403)
      expect((await create(api, 'alice', 'feature/missing')).status).toBe(400)
      // a tag a granted pattern covers is still not a branch
      const tagged = await create(api, 'alice', 'feature/v1')
      expect(tagged.status).toBe(400)
      expect((await tagged.json()).error).toBe('there is no branch feature/v1')
      expect((await api.call('POST', '/v1/sandboxes', { body: { repo: 'not a repo', ref: 'main' } })).status).toBe(400)
      expect((await api.call('POST', '/v1/sandboxes', { body: { repo: REPO } })).status).toBe(400)
      // the limit of two
      expect((await create(api)).status).toBe(201)
      expect((await create(api)).status).toBe(201)
      const over = await create(api)
      expect(over.status).toBe(413)
      expect((await over.json()).error).toMatch(/you have 2 sandboxes, the limit is 2/)
    })
  })

  it('runs the published build file on the files of a sandbox', async () => {
    await withApi('sandboxes-api-run', undefined, async (api) => {
      const sandbox = await (await create(api)).json()
      const submitted = await runOn(api, sandbox.id)
      expect(submitted.status).toBe(202)
      const run = await submitted.json()
      expect(run.source).toEqual({
        type: 'sandbox',
        id: sandbox.id,
        repo: REPO,
        commit: sandbox.commit,
        tree: expect.stringMatching(/^[0-9a-f]{40}/),
        clean: true,
      })
      const finished = await untilState(api, run.id, ['succeeded', 'failed'])
      expect(finished.state).toBe('succeeded')
      const events = await (await api.call('GET', `/v1/runs/${run.id}/events`)).text()
      expect(events).toContain('from-main')
    })
  })

  it("uses only the accounts that take sandbox runs, and only the caller's own sandboxes", async () => {
    await withApi('sandboxes-api-accounts', undefined, async (api) => {
      const sandbox = await (await create(api)).json()
      const ci = await runOn(api, sandbox.id, ['ci'])
      expect(ci.status).toBe(403)
      expect((await ci.json()).error).toBe('the account ci is not used by runs from sandbox')
      const unknown = await runOn(api, 'sbx_aaaaaaaaaaaaaaaa')
      expect(unknown.status).toBe(400)
      expect((await unknown.json()).error).toMatch(/there is no sandbox sbx_aaaaaaaaaaaaaaaa/)
      expect((await runOn(api, sandbox.id, ['build'], 'carol')).status).toBe(400)
      const dev = await runOn(api, sandbox.id, ['dev'])
      expect(dev.status).toBe(202)
      await untilState(api, (await dev.json()).id, ['succeeded', 'failed'])
    })
  })

  it('refuses a run whose paths go through a link a task or a commit left in the sandbox', async () => {
    await withApi('sandboxes-api-link', undefined, async (api) => {
      const outside = mkdtempSync(join(tmpdir(), 'hammerkit-sandbox-outside-'))
      let files = ''
      try {
        writeFileSync(join(outside, 'secret.txt'), 'server-secret')
        const sandbox = await (await create(api)).json()
        files = api.files(sandbox.id)
        // what `ln -s` in a task of an earlier run leaves behind, a junction on Windows
        symlinkSync(outside, join(api.files(sandbox.id), 'escape'), 'junction')
        const run = await (await runOn(api, sandbox.id, ['leak'])).json()
        const finished = await untilState(api, run.id, ['succeeded', 'failed'])
        expect(finished).toMatchObject({ state: 'failed', error: expect.stringMatching(/symbolic link escape/) })
        const events = await (await api.call('GET', `/v1/runs/${run.id}/events`)).text()
        expect(events).not.toContain('server-secret')

        // a link a task left inside what `**` matches is a source as a link: neither the run nor
        // the read of the files walks the server's disk
        const plant = await (await runOn(api, sandbox.id, ['plant'])).json()
        const plantRun = await untilState(api, plant.id, ['succeeded', 'failed'])
        expect(plantRun).toMatchObject({ state: 'succeeded' })
        const planted = `${JSON.stringify(plantRun)}\n${await (
          await api.call('GET', `/v1/runs/${plant.id}/logs`)
        ).text()}\n${api.log.slice(-20).join('\n')}`
        expect(
          lstatSync(join(api.files(sandbox.id), 'rootlink'), { throwIfNoEntry: false })?.isSymbolicLink(),
          planted
        ).toBe(true)
        const all = await (await runOn(api, sandbox.id, ['all'])).json()
        expect(await untilState(api, all.id, ['succeeded', 'failed'])).toMatchObject({ state: 'succeeded' })
      } finally {
        // the links stay in temp/, where whatever reads it after the test (the upload of a failed
        // CI job's files) would follow them onto the disk of the machine
        for (const link of files ? ['escape', 'rootlink'] : []) {
          rmSync(join(files, link), { force: true })
        }
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  it('refuses a run on a sandbox once a run grew the sandboxes of its owner over the limit', async () => {
    await withApi('sandboxes-api-over', undefined, async (api) => {
      const sandbox = await (await create(api)).json()
      // what a task of the run writes, measured when it is over
      writeFileSync(join(api.files(sandbox.id), 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
      const grew = await (await runOn(api, sandbox.id)).json()
      expect((await untilState(api, grew.id, ['succeeded', 'failed'])).state).toBe('succeeded')
      const refused = await runOn(api, sandbox.id)
      expect(refused.status).toBe(413)
      expect((await refused.json()).error).toMatch(/more than your limit of 1Mi, delete a sandbox/)
    })
  })

  it('gives a run on a sandbox no variable of the server, unless sandboxes.env lists it', async () => {
    await withApi('sandboxes-api-env', undefined, async (api) => {
      const sandbox = await (await create(api)).json()
      const refused = await runOn(api, sandbox.id, ['path'])
      expect(refused.status).toBe(400)
      expect((await refused.json()).error).toMatch(
        /reads env:PATH, which the server does not list in sandboxes.env.allow/
      )
    })
  })

  it('holds a sandbox for its run: no fetch then, and a delete cancels the run', async () => {
    let started = false
    const holding: RunExecutor = {
      execute: (_run, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          started = true
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }
    await withApi('sandboxes-api-held', holding, async (api) => {
      const sandbox = await (await create(api)).json()
      const run = await (await runOn(api, sandbox.id)).json()
      while (!started) {
        await sleep(5)
      }
      expect(await (await api.call('GET', `/v1/sandboxes/${sandbox.id}`)).json()).toMatchObject({
        busy: true,
        run: run.id,
      })
      const fetch = await api.call('POST', `/v1/sandboxes/${sandbox.id}/fetch`, { body: { ref: 'next' } })
      expect(fetch.status).toBe(409)
      // no edits while the run holds it, reading a file works
      const edit = await api.call('POST', `/v1/sandboxes/${sandbox.id}/edits`, {
        body: { ops: [{ op: 'write', path: 'x.txt', content: 'x' }] },
      })
      expect(edit.status).toBe(409)
      expect((await edit.json()).error).toMatch(`the run ${run.id} holds the sandbox`)
      expect((await api.call('GET', `/v1/sandboxes/${sandbox.id}/files/input.txt`)).status).toBe(200)
      // what walks the files waits for the run
      expect((await api.call('GET', `/v1/sandboxes/${sandbox.id}/tree`)).status).toBe(409)
      expect((await api.call('POST', `/v1/sandboxes/${sandbox.id}/search`, { body: { pattern: 'x' } })).status).toBe(
        409
      )
      // a second run waits for the first
      const second = await (await runOn(api, sandbox.id)).json()
      expect((await (await api.call('GET', `/v1/runs/${second.id}`)).json()).state).toBe('queued')
      expect((await api.call('DELETE', `/v1/sandboxes/${sandbox.id}`)).status).toBe(200)
      expect((await (await api.call('GET', `/v1/runs/${run.id}`)).json()).state).toBe('cancelled')
      expect(await (await api.call('GET', `/v1/runs/${second.id}`)).json()).toMatchObject({
        state: 'cancelled',
        error: 'the sandbox was deleted',
      })
    })
  })

  it('refuses the files of a sandbox once the caller lost its branch', async () => {
    await withApi('sandboxes-api-files-branch', undefined, async (api) => {
      git('branch', 'release/1')
      const release = { team: 'release' }
      const created = await api.call('POST', '/v1/sandboxes', {
        body: { repo: REPO, ref: 'release/1' },
        claims: release,
      })
      expect(created.status).toBe(201)
      const base = `/v1/sandboxes/${(await created.json()).id}`
      expect((await api.call('GET', `${base}/files/input.txt`, { claims: release })).status).toBe(200)
      // the same caller, whose token no longer grants release branches
      for (const [method, path] of [
        ['GET', `${base}/files/input.txt`],
        ['GET', `${base}/tree`],
        ['GET', `${base}/changes`],
      ]) {
        const refused = await api.call(method, path)
        expect(refused.status).toBe(403)
      }
      const edit = await api.call('POST', `${base}/edits`, {
        body: { ops: [{ op: 'write', path: 'x.txt', content: 'x' }] },
      })
      expect(edit.status).toBe(403)
    })
  })

  it('reads, searches and edits the files of a sandbox, and answers its changes', async () => {
    await withApi('sandboxes-api-files', undefined, async (api) => {
      const sandbox = await (await create(api)).json()
      const base = `/v1/sandboxes/${sandbox.id}`
      const tree = await (await api.call('GET', `${base}/tree`)).json()
      expect(tree).toMatchObject({ path: '', entries: [{ path: 'input.txt', type: 'file', size: 9 }], total: 1 })

      const read = await (await api.call('GET', `${base}/files/input.txt`)).json()
      expect(read).toMatchObject({ path: 'input.txt', content: '     1\tfrom-main', lines: 1 })

      // the raw surface of harness backends: write bytes, stat, read bytes
      const put = (path: string, body: string, headers: Record<string, string> = {}) =>
        fetch(`${api.url}${base}/files/${path}`, {
          method: 'PUT',
          headers: { authorization: api.auth(), ...headers },
          body,
        })
      const written = await put('src/new%20file.ts', 'export const x = 1\n')
      expect(written.status).toBe(201)
      expect(await written.json()).toMatchObject({ path: 'src/new file.ts', change: 'added', size: 19 })
      const head = await fetch(`${api.url}${base}/files/src/new%20file.ts`, {
        method: 'HEAD',
        headers: { authorization: api.auth() },
      })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe('19')
      expect(head.headers.get('x-hammerkit-type')).toBe('file')
      const raw = await fetch(`${api.url}${base}/files/src/new%20file.ts?raw`, {
        headers: { authorization: api.auth() },
      })
      expect(await raw.text()).toBe('export const x = 1\n')
      const etag = raw.headers.get('etag') as string
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
      expect((await put('src/new%20file.ts', 'y', { 'if-match': etag })).status).toBe(200)
      expect((await put('src/new%20file.ts', 'z', { 'if-match': etag })).status).toBe(412)
      expect(
        (await fetch(`${api.url}${base}/files/nothing`, { method: 'HEAD', headers: { authorization: api.auth() } }))
          .status
      ).toBe(404)
      expect(await (await api.call('GET', `${base}/files/src?stat`)).json()).toMatchObject({ type: 'directory' })
      expect((await api.call('GET', `${base}/files/.env`)).status).toBe(403)
      expect((await api.call('GET', `${base}/files/a%2F..%2F..%2Fx`)).status).toBe(400)

      const edits = await api.call('POST', `${base}/edits`, {
        body: {
          ops: [
            { op: 'replace', path: 'input.txt', old_string: 'main', new_string: 'sandbox' },
            {
              op: 'patch',
              patch: '*** Begin Patch\n*** Add File: docs/a.md\n+# A\n*** End Patch\n',
            },
          ],
        },
      })
      expect(edits.status).toBe(200)
      expect((await edits.json()).files.map((file: { path: string }) => file.path)).toEqual(['docs/a.md', 'input.txt'])
      const refused = await api.call('POST', `${base}/edits`, {
        body: { ops: [{ op: 'replace', path: 'input.txt', old_string: 'main', new_string: 'x' }] },
      })
      expect(refused.status).toBe(422)
      expect(await refused.json()).toMatchObject({
        op: 0,
        error: expect.stringMatching(/old_string is not in input\.txt/),
      })
      expect((await api.call('POST', `${base}/edits`, { body: { ops: [{ op: 'chmod', path: 'x' }] } })).status).toBe(
        400
      )

      const search = await api.call('POST', `${base}/search`, {
        body: { pattern: 'SANDBOX', '-i': true, output_mode: 'content' },
      })
      expect(await search.json()).toMatchObject({
        output_mode: 'content',
        matches: [{ path: 'input.txt', line: 1, text: 'from-sandbox' }],
      })

      const changes = await (await api.call('GET', `${base}/changes`)).json()
      expect(changes).toEqual({
        commit: sandbox.commit,
        files: [
          { path: 'docs/a.md', status: 'added', additions: 1, deletions: 0 },
          { path: 'input.txt', status: 'modified', additions: 1, deletions: 1 },
          { path: 'src/new file.ts', status: 'added', additions: 1, deletions: 0 },
        ],
      })
      const diff = await api.call('GET', `${base}/changes?format=diff`)
      expect(diff.headers.get('content-type')).toBe('text/x-diff; charset=utf-8')
      expect(await diff.text()).toContain('+from-sandbox')
      const patch = await (await api.call('GET', `${base}/changes?format=patch&message=Agent%20work`)).text()
      expect(patch).toContain('Subject: [PATCH] Agent work')

      // the files are the owner's alone
      expect((await api.call('GET', `${base}/tree`, { sub: 'carol' })).status).toBe(404)
      expect((await api.call('GET', `${base}/files/input.txt`, { sub: 'carol' })).status).toBe(404)
      expect(api.log.some((line) => line.startsWith(`sandbox edits ${sandbox.id} iss=`))).toBe(true)
    })
  })

  it('commits the changes of a sandbox as the caller and pushes them to an allowed branch', async () => {
    await withApi('sandboxes-api-push', undefined, async (api) => {
      const sandbox = await (await create(api)).json()
      const base = `/v1/sandboxes/${sandbox.id}`
      const push = (body: unknown, sub = 'alice') => api.call('POST', `${base}/push`, { sub, body })
      const nothing = await push({ branch: 'agent/one', message: 'Agent work' })
      expect(nothing.status).toBe(409)
      expect((await nothing.json()).error).toBe(`the sandbox ${sandbox.id} has no changes to push`)

      const edited = await api.call('POST', `${base}/edits`, {
        body: { ops: [{ op: 'replace', path: 'input.txt', old_string: 'main', new_string: 'agent' }] },
      })
      expect(edited.status).toBe(200)
      expect((await push({ branch: 'main', message: 'Agent work' })).status).toBe(403)
      expect((await push({ branch: 'agent/one' })).status).toBe(400)
      expect((await push({ branch: 'agent/one', message: 'x', author: 'someone' })).status).toBe(400)
      const signed = await push({ branch: 'agent/one', message: 'Agent work\n\nSigned-off-by: Bob <bob@corp.test>' })
      expect(signed.status).toBe(400)
      expect((await signed.json()).error).toMatch(/may not carry Signed-off-by/)
      expect((await push({ branch: 'agent/.hidden', message: 'Agent work' })).status).toBe(400)
      expect((await push({ branch: 'agent/one', message: 'Agent work' }, 'carol')).status).toBe(404)
      // carol may only pull: her own sandbox does not push
      const carols = await (await create(api, 'carol')).json()
      await api.call('POST', `/v1/sandboxes/${carols.id}/edits`, {
        sub: 'carol',
        body: { ops: [{ op: 'replace', path: 'input.txt', old_string: 'main', new_string: 'carol' }] },
      })
      const pulls = await api.call('POST', `/v1/sandboxes/${carols.id}/push`, {
        sub: 'carol',
        body: { branch: 'agent/one', message: 'Carol work' },
      })
      expect(pulls.status).toBe(403)
      expect((await pulls.json()).error).toBe(`you may not push from sandboxes of ${REPO}`)
      // main is alice's to pull from, not to push to
      const toMain = await push({ branch: 'main', message: 'Agent work' })
      expect((await toMain.json()).error).toBe(`you may only push to agent/** of ${REPO}`)
      expect((await api.call('GET', `${base}/push`)).status).toBe(405)

      const pushed = await push({ branch: 'agent/one', message: 'Agent work' })
      const answer = await pushed.json()
      // the error, when there is one, says why
      expect({ status: pushed.status, error: answer.error }).toEqual({ status: 200, error: undefined })
      const commit = git('rev-parse', 'agent/one')
      expect(answer).toMatchObject({
        branch: 'agent/one',
        commit,
        sandbox: { id: sandbox.id, ref: 'agent/one', commit, pushed: { 'agent/one': commit } },
      })
      // a token without name and email: the subject at the host of the issuer
      expect(git('log', '-1', '--format=%an <%ae>|%s', 'agent/one')).toBe('alice <alice@127.0.0.1>|Agent work')
      expect(git('show', 'agent/one:input.txt')).toBe('from-agent')
      // what is left to push is measured from the pushed commit
      expect(await (await api.call('GET', `${base}/changes`)).json()).toEqual({ commit, files: [] })
      expect(api.log.some((line) => line.startsWith(`sandbox push ${sandbox.id} iss=`))).toBe(true)

      // a caller who lost the repository, or sandboxes, pushes no more
      const again = await api.call('POST', `${base}/edits`, {
        body: { ops: [{ op: 'replace', path: 'input.txt', old_string: 'agent', new_string: 'again' }] },
      })
      expect(again.status).toBe(200)
      const alice = (entitlement: ServerConfig['entitlements'][number]) => entitlement.subject?.sub === 'alice'
      api.entitle((entitlements) =>
        entitlements.map((e) =>
          alice(e)
            ? { ...e, sandboxes: [{ repo: 'github.com/other/*', branches: { 'agent/**': 'push' as const } }] }
            : e
        )
      )
      const lostRepo = await push({ branch: 'agent/two', message: 'Agent work' })
      expect(lostRepo.status).toBe(403)
      api.entitle((entitlements) => entitlements.map((e) => (alice(e) ? { ...e, sandboxes: undefined } : e)))
      const lostSandboxes = await push({ branch: 'agent/two', message: 'Agent work' })
      expect(lostSandboxes.status).toBe(403)
      expect((await lostSandboxes.json()).error).toBe('you are not entitled to keep sandboxes on this server')
      expect(git('branch', '--list', 'agent/two')).toBe('')
    })
  })
})

describe('the author of a push', () => {
  const principal = (sub: string, claims: Record<string, string> = {}) => ({
    iss: 'https://login.corp.test',
    sub,
    groups: [],
    claims,
  })

  it('is the caller as their token names them', () => {
    expect(author(principal('4f1c', { name: 'Alice Doe', email: 'alice@corp.test' }))).toEqual({
      name: 'Alice Doe',
      email: 'alice@corp.test',
    })
    expect(author(principal('agent-7', { preferred_username: 'agent' }))).toEqual({
      name: 'agent',
      email: 'agent-7@login.corp.test',
    })
  })

  it('does not take an address the issuer did not verify', () => {
    expect(author({ ...principal('agent-7', { name: 'Eve', email: 'ceo@corp.test' }), emailVerified: false })).toEqual({
      name: 'Eve',
      email: 'agent-7@login.corp.test',
    })
    expect(author({ ...principal('a', { email: 'a@corp.test' }), emailVerified: true }).email).toBe('a@corp.test')
  })

  it('is named by the local part of a verified address when the token has no name', () => {
    // a Google service account's ID token: a verified email, a numeric sub and nothing else
    const account = 'deploy-bot@my-project.iam.gserviceaccount.com'
    expect(author({ ...principal('112233445566778899000', { email: account }), emailVerified: true })).toEqual({
      name: 'deploy-bot',
      email: account,
    })
    expect(author({ ...principal('112233445566778899000', { email: 'ceo@corp.test' }), emailVerified: false })).toEqual(
      {
        name: '112233445566778899000',
        email: '112233445566778899000@login.corp.test',
      }
    )
  })

  it('takes nothing from a claim that would break the commit header', () => {
    expect(author(principal('a b|c', { name: 'Eve <eve@x>\nX', email: 'not an email' }))).toEqual({
      name: 'Eve eve@xX',
      email: 'a-b-c@login.corp.test',
    })
  })
})
