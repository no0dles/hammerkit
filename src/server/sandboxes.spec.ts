import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveRef } from './git-checkout'
import { RepoAccess } from './repo-access'
import { HostSandboxStorage, SandboxPushFailed, SandboxStorage } from './sandbox-storage'
import { SandboxError, SandboxLimits, SandboxRegistry } from './sandboxes'

const alice = { iss: 'https://idp.corp', sub: 'alice' }
const bob = { iss: 'https://idp.corp', sub: 'bob' }
const REPO = 'git.test/corp/payments'

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

// a write credential that is easy to find wherever it ends up
const PUSH_TOKEN = 'wr1te-7c4f9e2a1b'

// every file below a directory, links not followed
function allFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? allFiles(path) : entry.isFile() ? [path] : []
  })
}

describe('SandboxRegistry', () => {
  let root: string
  let repository: string
  let first: string
  let second: string
  let holder: string | undefined
  let stopped: string[]
  // what the operator lets sandboxes push to
  let pushCredentialFails: boolean
  let logged: string[]
  let secret: { from: string; account: string; username: string } | undefined
  // what the caller's entitlements let them push to
  let allowed: string[]

  const registryWith = (
    limits: Partial<SandboxLimits> = {},
    storage: SandboxStorage = new HostSandboxStorage(join(root, 'files'), process.env)
  ) => {
    const sandboxes = new SandboxRegistry({
      storage,
      records: join(root, 'records'),
      log: (line) => logged.push(line),
      limits: { count: 5, bytes: 100 * 1024 * 1024, total: 1024 * 1024 * 1024, ...limits },
      repos: {
        url: () => repository,
        credentials: async () => ({ env: { ...(process.env as { [key: string]: string }) }, values: ['s3cret'] }),
        pushCredentials: async () => {
          if (pushCredentialFails) {
            throw new Error('could not read the source credential echo:push: project secret-vault-7 denied')
          }
          // as the server hands it to git: in the environment of the one push
          return {
            env: {
              ...(process.env as { [key: string]: string }),
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'http.https://git.test/.extraHeader',
              GIT_CONFIG_VALUE_0: `Authorization: Basic ${PUSH_TOKEN}`,
            },
            values: [PUSH_TOKEN],
          }
        },
        source: (repo) => (repo === REPO ? { match: 'git.test/corp/*', secret } : undefined),
        resolve: (_repo, ref, signal, only) =>
          resolveRef(repository, ref, process.env, signal ?? AbortSignal.timeout(60_000), only),
        scrub: (e, values) => RepoAccess.prototype.scrub.call(undefined, e, values),
      },
    })
    sandboxes.useRuns({
      holder: () => holder,
      stop: async (id) => {
        stopped.push(id)
      },
    })
    return sandboxes
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-sandboxes-'))
    repository = join(root, 'repository')
    holder = undefined
    stopped = []
    pushCredentialFails = false
    logged = []
    secret = { from: 'echo:scm', account: 'scm', username: 'x-access-token' }
    allowed = ['agent/**']
    mkdirSync(repository)
    git(repository, 'init', '--quiet', '--initial-branch=main')
    writeFileSync(join(repository, 'input.txt'), 'one')
    writeFileSync(join(repository, '.gitignore'), 'node_modules\n')
    git(repository, 'add', '.')
    git(repository, 'commit', '--quiet', '-m', 'one')
    first = git(repository, 'rev-parse', 'HEAD')
    git(repository, 'checkout', '--quiet', '-b', 'next')
    writeFileSync(join(repository, 'input.txt'), 'two')
    git(repository, 'commit', '--quiet', '-am', 'two')
    second = git(repository, 'rev-parse', 'HEAD')
    git(repository, 'checkout', '--quiet', 'main')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('fetches a ref into a sandbox of its own, with the git data outside of the files', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    expect(sandbox).toMatchObject({ repo: REPO, ref: 'main', commit: first, owner: alice })
    expect(sandbox.id).toMatch(/^sbx_[A-Za-z0-9_-]{16}$/)
    expect(sandbox.bytes).toBeGreaterThan(0)
    const files = (await sandboxes.attach(sandbox.id, root)).directory
    expect(readFileSync(join(files, 'input.txt'), 'utf8')).toBe('one')
    expect(existsSync(join(files, '.git'))).toBe(false)
    expect(await sandboxes.state(sandbox.id)).toEqual({ commit: first, tree: expect.any(String), clean: true })
  })

  it("is its owner's: anybody else does not find it", async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    expect(sandboxes.get(alice, sandbox.id)?.id).toBe(sandbox.id)
    expect(sandboxes.get(bob, sandbox.id)).toBeUndefined()
    expect(sandboxes.list(bob)).toEqual([])
    expect(await sandboxes.remove(bob, sandbox.id)).toBe(false)
    await expect(sandboxes.fetch(bob, sandbox.id, 'next')).rejects.toMatchObject({ status: 404 })
  })

  it('names the files as they are, changed or not, without touching the index', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    const files = (await sandboxes.attach(sandbox.id, root)).directory
    const clean = await sandboxes.state(sandbox.id)
    // what .gitignore leaves out is not a change
    mkdirSync(join(files, 'node_modules'))
    writeFileSync(join(files, 'node_modules', 'x.js'), 'x')
    expect(await sandboxes.state(sandbox.id)).toEqual(clean)
    writeFileSync(join(files, 'new.txt'), 'new')
    const changed = await sandboxes.state(sandbox.id)
    expect(changed).toMatchObject({ commit: first, clean: false })
    expect(changed.tree).not.toBe(clean.tree)
    expect(await sandboxes.state(sandbox.id)).toEqual(changed)
    rmSync(join(files, 'new.txt'))
    expect(await sandboxes.state(sandbox.id)).toEqual(clean)
  })

  it('names a link a task left as the link, never what it points to', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    const files = (await sandboxes.attach(sandbox.id, root)).directory
    const clean = await sandboxes.state(sandbox.id)
    const outside = mkdtempSync(join(tmpdir(), 'hammerkit-sandboxes-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'server file')
      // what `ln -s` or `mklink /J` of a task leaves, a junction on Windows (Git for Windows
      // takes a junction for a directory); one where .gitignore leaves it out is no change
      mkdirSync(join(files, 'node_modules'))
      symlinkSync(outside, join(files, 'node_modules', 'pkg'), 'junction')
      expect(await sandboxes.state(sandbox.id)).toEqual(clean)
      symlinkSync(outside, join(files, 'escape'), 'junction')
      const changed = await sandboxes.state(sandbox.id)
      expect(changed).toMatchObject({ commit: first, clean: false })
      // the tree of the commit and `escape` as a link to its target, the tree git writes for
      // a link on Linux
      const gitDir = join(root, 'files', sandbox.id, 'git')
      const read = (args: string[], input?: string) =>
        execFileSync('git', [`--git-dir=${gitDir}`, ...args], { input, encoding: 'utf8' }).trim()
      const link = read(['hash-object', '--stdin'], readlinkSync(join(files, 'escape')))
      const entries = `${read(['ls-tree', first])}\n120000 blob ${link}\tescape\n`
      expect(changed.tree).toBe(read(['mktree', '--missing'], entries))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does not run the hooks or the config a task wrote into the files', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    const files = (await sandboxes.attach(sandbox.id, root)).directory
    const marker = join(root, 'ran')
    mkdirSync(join(files, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(files, '.git', 'config'), `[core]\n\tfsmonitor = touch ${marker}\n`)
    expect((await sandboxes.state(sandbox.id)).commit).toBe(first)
    expect(existsSync(marker)).toBe(false)
  })

  it('moves a sandbox without changes to another ref', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    const fetched = await sandboxes.fetch(alice, sandbox.id, 'next')
    expect(fetched).toMatchObject({ ref: 'next', commit: second })
    expect(readFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'utf8')).toBe('two')
  })

  it('does not move a sandbox with changes, nor one a run holds', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
    await expect(sandboxes.fetch(alice, sandbox.id, 'next')).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/has changes/),
    })
    holder = 'run_xxxxxxxxxxxxxxxx'
    await expect(sandboxes.fetch(alice, sandbox.id, 'next')).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/the run run_xxxxxxxxxxxxxxxx holds the sandbox/),
    })
  })

  it('says what is wrong with a ref', async () => {
    const sandboxes = registryWith()
    await expect(sandboxes.create(alice, REPO, 'missing')).rejects.toMatchObject({
      status: 400,
      message: 'there is no branch missing',
    })
    expect(sandboxes.usage(alice)).toEqual({ count: 0, bytes: 0 })
  })

  it('starts from a branch only, never from a tag or a commit', async () => {
    git(repository, 'tag', 'v1', first)
    // a tag with the name of a branch is not what a sandbox of that branch gets
    git(repository, 'tag', 'next', first)
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'next')
    expect(sandbox.commit).toBe(second)
    expect(readFileSync(join(root, 'files', sandbox.id, 'files', 'input.txt'), 'utf8')).toBe('two')
    for (const [ref, message] of [
      ['v1', 'there is no branch v1'],
      [first, `a sandbox starts from a branch, ${first} is a commit`],
      ['refs/heads/main', '"refs/heads/main" is not a branch'],
    ]) {
      await expect(sandboxes.create(alice, REPO, ref)).rejects.toMatchObject({ status: 400, message })
      await expect(sandboxes.fetch(alice, sandbox.id, ref)).rejects.toMatchObject({ status: 400, message })
    }
    expect(sandboxes.usage(alice).count).toBe(1)
    expect((await sandboxes.fetch(alice, sandbox.id, 'main')).commit).toBe(first)
  })

  it('sees a same-size change made in the second of the checkout', async () => {
    const sandboxes = registryWith()
    for (let attempt = 0; attempt < 5; attempt++) {
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      // 'one' to 'onx' right away: same size, and most likely the same second as the index
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'onx')
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect((await sandboxes.state(sandbox.id)).clean).toBe(false)
      await expect(sandboxes.fetch(alice, sandbox.id, 'next')).rejects.toMatchObject({ status: 409 })
      await sandboxes.remove(alice, sandbox.id)
    }
  }, 30_000)

  it('does not run a filter the git config of the machine defines when it reads the files', async () => {
    const marker = join(root, 'filter-ran')
    const config = join(root, 'gitconfig')
    writeFileSync(config, `[filter "x"]\n\tclean = touch '${marker.replace(/\\/g, '/')}' && cat\n`)
    const sandboxes = new SandboxRegistry({
      storage: new HostSandboxStorage(join(root, 'files'), { ...process.env, GIT_CONFIG_GLOBAL: config }),
      records: join(root, 'records'),
      limits: { count: 5, bytes: 100 * 1024 * 1024, total: 1024 * 1024 * 1024 },
      repos: {
        url: () => repository,
        credentials: async () => ({ env: { ...(process.env as { [key: string]: string }) }, values: [] }),
        pushCredentials: async () => {
          throw new Error('this server does not push')
        },
        source: () => undefined,
        resolve: async (_repo, ref) => git(repository, 'rev-parse', ref),
        scrub: (e) => (e instanceof Error ? e : new Error(String(e))),
      },
    })
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    const files = (await sandboxes.attach(sandbox.id, root)).directory
    writeFileSync(join(files, '.gitattributes'), '* filter=x\n')
    writeFileSync(join(files, 'written.txt'), 'by a task')
    expect((await sandboxes.state(sandbox.id)).clean).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  it('checks out the files as committed whatever line endings the git config of the machine asks for', async () => {
    const config = join(root, 'crlf-gitconfig')
    writeFileSync(config, '[core]\n\tautocrlf = true\n')
    const env = { ...(process.env as { [key: string]: string }), GIT_CONFIG_GLOBAL: config }
    const sandboxes = new SandboxRegistry({
      storage: new HostSandboxStorage(join(root, 'files'), env),
      records: join(root, 'records'),
      limits: { count: 5, bytes: 100 * 1024 * 1024, total: 1024 * 1024 * 1024 },
      repos: {
        url: () => repository,
        credentials: async () => ({ env, values: [] }),
        pushCredentials: async () => {
          throw new Error('this server does not push')
        },
        source: () => undefined,
        resolve: async (_repo, ref) => git(repository, 'rev-parse', ref),
        scrub: (e) => (e instanceof Error ? e : new Error(String(e))),
      },
    })
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    expect((await sandboxes.state(sandbox.id)).clean).toBe(true)
    await sandboxes.fetch(alice, sandbox.id, 'next')
    expect((await sandboxes.state(sandbox.id)).clean).toBe(true)
  })

  it('keeps a caller within their count and bytes, and the server within its total', async () => {
    const counted = registryWith({ count: 1 })
    await counted.create(alice, REPO, 'main')
    await expect(counted.create(alice, REPO, 'main')).rejects.toMatchObject({
      status: 413,
      message: expect.stringMatching(/you have 1 sandboxes, the limit is 1/),
    })
    expect((await counted.create(bob, REPO, 'main')).repo).toBe(REPO)

    const small = registryWith({ bytes: 10 })
    await expect(small.create(alice, REPO, 'main')).rejects.toBeInstanceOf(SandboxError)
    await expect(small.create(alice, REPO, 'main')).rejects.toMatchObject({ status: 413 })
    expect(small.usage(alice)).toEqual({ count: 0, bytes: 0 })

    const full = registryWith({ total: 10 })
    await expect(full.create(alice, REPO, 'main')).rejects.toMatchObject({ status: 507 })
  })

  it('counts creates under way against the bytes, so parallel creates can not pass the limit together', async () => {
    const one = await registryWith().create(alice, REPO, 'main')
    const sandboxes = registryWith({ bytes: Math.floor(one.bytes * 1.5) })
    const results = await Promise.allSettled([
      sandboxes.create(alice, REPO, 'main'),
      sandboxes.create(alice, REPO, 'main'),
      sandboxes.create(alice, REPO, 'main'),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    for (const result of results.filter((result) => result.status === 'rejected')) {
      expect(result).toMatchObject({ reason: { status: 413 } })
    }
    expect(sandboxes.usage(alice).count).toBe(1)
    expect(sandboxes.usage(alice).bytes).toBeLessThanOrEqual(Math.floor(one.bytes * 1.5))
  })

  it('stops the runs of a sandbox it deletes, and its files go with it', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    expect(await sandboxes.remove(alice, sandbox.id)).toBe(true)
    expect(stopped).toEqual([sandbox.id])
    expect(sandboxes.get(alice, sandbox.id)).toBeUndefined()
    expect(readdirSync(join(root, 'files'))).toEqual([])
    expect(readdirSync(join(root, 'records'))).toEqual([])
  })

  it('keeps the sandboxes over a restart, and drops what a create left behind', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    mkdirSync(join(root, 'files', 'sbx_halfcreatedxxxxxx'))
    const restarted = registryWith()
    await restarted.load()
    expect(restarted.list(alice)).toEqual([sandbox])
    expect(readdirSync(join(root, 'files'))).toEqual([sandbox.id])
  })

  it('keeps the files of a record it can not read, and does not start on records it can not list', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    writeFileSync(join(root, 'records', `${sandbox.id}.json`), '{ not json')
    const restarted = registryWith()
    await restarted.load()
    expect(restarted.list(alice)).toEqual([])
    expect(readdirSync(join(root, 'files'))).toEqual([sandbox.id])

    rmSync(join(root, 'records'), { recursive: true })
    writeFileSync(join(root, 'records'), 'not a directory')
    await expect(registryWith().load()).rejects.toThrow()
    expect(readdirSync(join(root, 'files'))).toEqual([sandbox.id])
  })

  it.skipIf(process.platform === 'win32')(
    'counts, reads and removes what a task took its own permissions away from',
    async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      const files = (await sandboxes.attach(sandbox.id, root)).directory
      mkdirSync(join(files, 'hidden'))
      writeFileSync(join(files, 'hidden', 'big.bin'), Buffer.alloc(64 * 1024))
      chmodSync(join(files, 'hidden', 'big.bin'), 0)
      chmodSync(join(files, 'hidden'), 0)
      await sandboxes.measure(sandbox.id)
      expect(sandboxes.get(alice, sandbox.id)?.bytes).toBeGreaterThanOrEqual(sandbox.bytes + 64 * 1024)
      expect((await sandboxes.state(sandbox.id)).clean).toBe(false)
      expect(await sandboxes.remove(alice, sandbox.id)).toBe(true)
      expect(readdirSync(join(root, 'files'))).toEqual([])
    }
  )

  it('measures a large node_modules exactly, and walks a sandbox once per run', async () => {
    const storage = new HostSandboxStorage(join(root, 'files'), process.env)
    const signal = AbortSignal.timeout(60_000)
    const key = { id: 'sbx_large', owner: alice }
    await storage.create(key, { url: repository, ref: 'main', env: process.env as any, signal })
    const files = (await storage.attach(key)).directory
    const before = await storage.usage(key)
    // what `npm ci` leaves: ignored, and tens of thousands of files in a real project
    for (let pkg = 0; pkg < 40; pkg++) {
      mkdirSync(join(files, 'node_modules', `pkg-${pkg}`, 'lib'), { recursive: true })
      for (let file = 0; file < 250; file++) {
        writeFileSync(join(files, 'node_modules', `pkg-${pkg}`, 'lib', `${file}.js`), 'x'.repeat(10))
      }
    }
    const walk = vi.spyOn(storage as any, 'walk')
    // what a run ends with
    expect(await storage.usage(key)).toBe(before + 40 * 250 * 10)
    expect(walk).toHaveBeenCalledTimes(1)
    // the next run is submitted and starts on what that walk left: nothing ran in between
    expect(await storage.state(key)).toMatchObject({ clean: true })
    expect(await storage.state(key)).toMatchObject({ clean: true })
    expect(walk).toHaveBeenCalledTimes(1)
    // while it runs, its tasks write: a state then walks, and so does the one after
    await storage.attach(key)
    writeFileSync(join(files, 'new.txt'), 'new')
    chmodSync(join(files, 'new.txt'), 0o000)
    expect(await storage.state(key)).toMatchObject({ clean: false })
    expect(await storage.state(key)).toMatchObject({ clean: false })
    expect(walk).toHaveBeenCalledTimes(3)
    // until its measure: one walk per run
    await storage.usage(key)
    expect(await storage.state(key)).toMatchObject({ clean: false })
    expect(walk).toHaveBeenCalledTimes(4)
  }, 60_000)

  it('reads the files of an edit without walking them again', async () => {
    const storage = new HostSandboxStorage(join(root, 'files'), process.env)
    const signal = AbortSignal.timeout(60_000)
    const key = { id: 'sbx_edit', owner: alice }
    await storage.create(key, { url: repository, ref: 'main', env: process.env as any, signal })
    const files = (await storage.attach(key)).directory
    // a run left a link, and was measured
    mkdirSync(join(files, 'dir'))
    symlinkSync(join(files, 'dir'), join(files, 'link'), 'junction')
    await storage.usage(key)
    const walk = vi.spyOn(storage as any, 'walk')
    const edits = storage.files(key)
    await (await edits.plan([{ op: 'delete', path: 'link' }])).commit()
    await (await edits.plan([{ op: 'write', path: 'link', content: 'a file now\n' }])).commit()
    expect(await edits.changes()).toEqual([{ path: 'link', status: 'added', additions: 1, deletions: 0 }])
    expect(await storage.state(key)).toMatchObject({ clean: false })
    expect(walk).not.toHaveBeenCalled()
  }, 60_000)

  it('lets a change wait for a delete, and then does not find the sandbox', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    let release = () => undefined as void
    const held = sandboxes.withSandbox(alice, sandbox.id, () => new Promise<void>((resolve) => (release = resolve)))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const removed = sandboxes.remove(alice, sandbox.id)
    // a submit that looked the sandbox up before the delete and now waits for it
    const waiting = sandboxes.withSandbox(alice, sandbox.id, async () => 'ran').catch((e: unknown) => e)
    release()
    await held
    expect(await removed).toBe(true)
    expect(await waiting).toMatchObject({ status: 404 })
  })

  it('measures what a run wrote', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'big.bin'), Buffer.alloc(64 * 1024))
    await sandboxes.measure(sandbox.id)
    expect(sandboxes.get(alice, sandbox.id)?.bytes).toBeGreaterThanOrEqual(sandbox.bytes + 64 * 1024)
    expect(registryWith({ bytes: sandbox.bytes }).overLimit(alice)).toBeUndefined()
  })

  it('keeps edits within the server total, and counts what they free', async () => {
    const sandbox = await registryWith().create(alice, REPO, 'main')
    const full = registryWith({ total: sandbox.bytes + 10 })
    await full.load()
    const write = (content: string) => [{ op: 'write' as const, path: 'notes/new.txt', content }]
    await expect(full.edit(alice, sandbox.id, write('x'.repeat(100)))).rejects.toMatchObject({
      status: 507,
      message: 'the server has no room for these edits',
    })
    expect(await full.files(alice, sandbox.id).stat('notes/new.txt')).toBeUndefined()
    await full.edit(alice, sandbox.id, write('x'.repeat(10)))
    expect(full.get(alice, sandbox.id)?.bytes).toBe(sandbox.bytes + 10)
    // a batch that frees bytes makes room again
    await full.edit(alice, sandbox.id, [{ op: 'delete', path: 'notes/new.txt' }])
    expect(full.get(alice, sandbox.id)?.bytes).toBe(sandbox.bytes)
    await full.edit(alice, sandbox.id, [{ op: 'delete', path: 'input.txt' }])
    expect(full.get(alice, sandbox.id)?.bytes).toBe(sandbox.bytes - 3)
  })

  it("edits only an owner's sandbox that no run holds, within their bytes", async () => {
    const sandboxes = registryWith({ bytes: 1024 * 1024 })
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    const write = (content: string) => [{ op: 'write' as const, path: 'notes/new.txt', content }]
    await expect(sandboxes.edit(bob, sandbox.id, write('x'))).rejects.toMatchObject({ status: 404 })
    holder = 'run_1'
    await expect(sandboxes.edit(alice, sandbox.id, write('x'))).rejects.toMatchObject({
      status: 409,
      message: `the run run_1 holds the sandbox ${sandbox.id}, wait for it to finish or cancel it`,
    })
    // reads work while a run holds it
    expect((await sandboxes.files(alice, sandbox.id).read('input.txt', {})).content).toBe('     1\tone')
    holder = undefined
    expect(await sandboxes.edit(alice, sandbox.id, write('hello'), true)).toMatchObject([{ change: 'added' }])
    expect(await sandboxes.files(alice, sandbox.id).stat('notes/new.txt')).toBeUndefined()
    expect(await sandboxes.edit(alice, sandbox.id, write('hello'))).toMatchObject([{ path: 'notes/new.txt', size: 5 }])
    const after = sandboxes.get(alice, sandbox.id)
    expect(after?.bytes).toBe(sandbox.bytes + 5)
    await expect(sandboxes.edit(alice, sandbox.id, write('x'.repeat(1024 * 1024)))).rejects.toMatchObject({
      status: 413,
    })
    expect((await sandboxes.files(alice, sandbox.id).read('notes/new.txt', {})).content).toBe('     1\thello')
    expect(await sandboxes.read(alice, sandbox.id, (files) => files.changes())).toEqual([
      { path: 'notes/new.txt', status: 'added', additions: 1, deletions: 0 },
    ])
  })

  describe('push', () => {
    const author = { name: 'Alice Agent', email: 'alice@corp.test', message: 'Agent work' }

    it('commits the changes as the caller, pushes them to a new branch and moves the sandbox there', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      const files = (await sandboxes.attach(sandbox.id, root)).directory
      writeFileSync(join(files, 'input.txt'), 'changed')
      writeFileSync(join(files, 'new.txt'), 'new')
      // what .gitignore and the deny list leave out stays on the server
      mkdirSync(join(files, 'node_modules'))
      writeFileSync(join(files, 'node_modules', 'x.js'), 'x')
      writeFileSync(join(files, '.env'), 'TOKEN=s3cret')

      const pushed = await sandboxes.push(alice, sandbox.id, 'agent/fix-1', author, allowed)
      const commit = git(repository, 'rev-parse', 'agent/fix-1')
      expect(pushed).toMatchObject({ ref: 'agent/fix-1', commit, pushed: { 'agent/fix-1': commit } })
      expect(git(repository, 'rev-parse', 'agent/fix-1^')).toBe(first)
      expect(git(repository, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'agent/fix-1')).toBe(
        'Alice Agent <alice@corp.test>|Alice Agent <alice@corp.test>|Agent work'
      )
      expect(git(repository, 'ls-tree', '-r', '--name-only', 'agent/fix-1').split('\n')).toEqual([
        '.gitignore',
        'input.txt',
        'new.txt',
      ])
      expect(git(repository, 'show', 'agent/fix-1:input.txt')).toBe('changed')

      // the sandbox is at what it pushed, the files are as they were: only the .env, which
      // never leaves the server, is left
      expect((await sandboxes.state(sandbox.id)).commit).toBe(commit)
      expect(readFileSync(join(files, '.env'), 'utf8')).toBe('TOKEN=s3cret')
      await expect(sandboxes.push(alice, sandbox.id, 'agent/fix-1', author, allowed)).rejects.toMatchObject({
        status: 409,
        message: `the sandbox ${sandbox.id} has no changes to push`,
      })

      // the next push adds a commit to the branch it pushed
      writeFileSync(join(files, 'new.txt'), 'newer')
      const again = await sandboxes.push(alice, sandbox.id, 'agent/fix-1', { ...author, message: 'More' }, allowed)
      expect(git(repository, 'rev-parse', 'agent/fix-1')).toBe(again.commit)
      expect(git(repository, 'rev-parse', 'agent/fix-1^')).toBe(commit)
      // and the record keeps it over a restart
      const restarted = registryWith()
      await restarted.load()
      expect(restarted.get(alice, sandbox.id)).toMatchObject({
        commit: again.commit,
        pushed: { 'agent/fix-1': again.commit },
      })
    })

    it('never pushes the run state hammerkit keeps next to a build file', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      const files = (await sandboxes.attach(sandbox.id, root)).directory
      writeFileSync(join(files, 'input.txt'), 'fixed')
      // what a run on the sandbox writes, at the root and next to a build file further down
      mkdirSync(join(files, '.hammerkit', 'last-resolved'), { recursive: true })
      writeFileSync(join(files, '.hammerkit', 'last-resolved', 'test-a94a8fe5.json'), '{}')
      mkdirSync(join(files, 'packages', 'app', '.hammerkit', 'last-resolved'), { recursive: true })
      writeFileSync(join(files, 'packages', 'app', '.hammerkit', 'last-resolved', 'build-1.json'), '{}')

      const pushed = await sandboxes.push(alice, sandbox.id, 'agent/fix-cart', author, allowed)
      expect(git(repository, 'ls-tree', '-r', '--name-only', pushed.commit).split('\n')).toEqual([
        '.gitignore',
        'input.txt',
      ])
      // it stays in the sandbox for the next run, and alone is nothing to push
      expect(readFileSync(join(files, '.hammerkit', 'last-resolved', 'test-a94a8fe5.json'), 'utf8')).toBe('{}')
      await expect(sandboxes.push(alice, sandbox.id, 'agent/fix-cart', author, allowed)).rejects.toMatchObject({
        status: 409,
      })
    })

    it('pushes when the branch it started from moved on', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join(repository, 'other.txt'), 'other')
      git(repository, 'add', 'other.txt')
      git(repository, 'commit', '--quiet', '-m', 'moved on')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      const pushed = await sandboxes.push(alice, sandbox.id, 'agent/late', author, allowed)
      expect(git(repository, 'rev-parse', 'agent/late^')).toBe(first)
      expect(pushed.commit).toBe(git(repository, 'rev-parse', 'agent/late'))
    })

    it('only pushes to the branches the entitlements allow, with a credential of the server', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      await expect(sandboxes.push(alice, sandbox.id, 'main', author, allowed)).rejects.toMatchObject({
        status: 403,
        message: `you may only push to agent/** of ${REPO}`,
      })
      await expect(sandboxes.push(alice, sandbox.id, 'agent/../main', author, allowed)).rejects.toMatchObject({
        status: 400,
      })
      await expect(sandboxes.push(alice, sandbox.id, '--force', author, allowed)).rejects.toMatchObject({ status: 400 })
      await expect(sandboxes.push(bob, sandbox.id, 'agent/x', author, allowed)).rejects.toMatchObject({ status: 404 })
      await expect(sandboxes.push(alice, sandbox.id, 'agent/x', author, [])).rejects.toMatchObject({
        status: 403,
        message: `you may not push from sandboxes of ${REPO}`,
      })
      secret = undefined
      await expect(sandboxes.push(alice, sandbox.id, 'agent/x', author, allowed)).rejects.toMatchObject({
        status: 403,
        message: `this server does not push to ${REPO}`,
      })
      expect(git(repository, 'branch', '--list', 'agent/*')).toBe('')
    })

    it('never writes over a branch it did not push, or one that moved since it did', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      const files = (await sandboxes.attach(sandbox.id, root)).directory
      git(repository, 'branch', 'agent/taken', 'next')
      writeFileSync(join(files, 'input.txt'), 'changed')
      await expect(sandboxes.push(alice, sandbox.id, 'agent/taken', author, allowed)).rejects.toMatchObject({
        status: 409,
        message: 'agent/taken exists and this sandbox did not push it, push to a new branch',
      })
      expect(git(repository, 'rev-parse', 'agent/taken')).toBe(second)

      const pushed = await sandboxes.push(alice, sandbox.id, 'agent/mine', author, allowed)
      git(repository, 'branch', '--force', 'agent/mine', 'next')
      writeFileSync(join(files, 'input.txt'), 'again')
      await expect(sandboxes.push(alice, sandbox.id, 'agent/mine', author, allowed)).rejects.toMatchObject({
        status: 409,
        message: 'agent/mine moved since this sandbox pushed it, push to a new branch',
      })

      // a sandbox moved to another commit since does not rewrite the branch it pushed
      git(repository, 'branch', '--force', 'agent/mine', pushed.commit)
      writeFileSync(join(files, 'input.txt'), 'changed')
      await sandboxes.fetch(alice, sandbox.id, 'next')
      writeFileSync(join(files, 'input.txt'), 'on next')
      await expect(sandboxes.push(alice, sandbox.id, 'agent/mine', author, allowed)).rejects.toMatchObject({
        status: 409,
        message: `agent/mine is at ${pushed.commit}, which the sandbox is no longer on: push to a new branch`,
      })
      expect(git(repository, 'rev-parse', 'agent/mine')).toBe(pushed.commit)
    })

    it('leaves it to the remote to refuse a branch that appeared or moved after it was read', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      git(repository, 'branch', 'agent/raced', 'next')
      const storage = new HostSandboxStorage(join(root, 'files'), process.env)
      const request = {
        url: repository,
        branch: 'agent/raced',
        author,
        env: { ...(process.env as { [key: string]: string }) },
        signal: AbortSignal.timeout(60_000),
      }
      await expect(storage.push({ id: sandbox.id, owner: alice }, { ...request, expect: null })).rejects.toThrow(
        'the remote refused the push to agent/raced: [rejected] (stale info)'
      )
      await expect(storage.push({ id: sandbox.id, owner: alice }, { ...request, expect: first })).rejects.toThrow(
        'the remote refused the push to agent/raced: [rejected] (stale info)'
      )
      expect(git(repository, 'rev-parse', 'agent/raced')).toBe(second)
      // nothing moved in the sandbox
      expect(await sandboxes.state(sandbox.id)).toMatchObject({ commit: first, clean: false })

      // somebody creates the branch after the registry read it
      const racing: SandboxStorage = Object.create(storage)
      racing.push = async (id, push) => {
        git(repository, 'branch', 'agent/late', 'next')
        return storage.push(id, push)
      }
      const raced = registryWith({}, racing)
      await raced.load()
      await expect(raced.push(alice, sandbox.id, 'agent/late', author, allowed)).rejects.toMatchObject({
        status: 409,
        message: 'agent/late changed while the sandbox pushed to it, push to a new branch',
      })
      expect(git(repository, 'rev-parse', 'agent/late')).toBe(second)
    })

    it('takes the branch as pushed when the remote has it, though the push failed late', async () => {
      const storage = new HostSandboxStorage(join(root, 'files'), process.env)
      const late: SandboxStorage = Object.create(storage)
      late.push = async (id, request) => {
        const commit = (await storage.push(id, request)) as string
        // a read of the sandbox meanwhile prunes what no ref keeps
        await storage.state(id)
        throw new SandboxPushFailed(commit, new Error('the push timed out'))
      }
      const sandboxes = registryWith({}, late)
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      const pushed = await sandboxes.push(alice, sandbox.id, 'agent/late', author, allowed)
      expect(pushed).toMatchObject({ commit: git(repository, 'rev-parse', 'agent/late'), ref: 'agent/late' })
      expect(await sandboxes.state(sandbox.id)).toMatchObject({ commit: pushed.commit, clean: true })
    })

    it('keeps the branch as its own when the sandbox can not be moved after the push', async () => {
      const storage = new HostSandboxStorage(join(root, 'files'), process.env)
      const stuck: SandboxStorage = Object.create(storage)
      stuck.moveTo = async () => {
        throw new Error('disk full')
      }
      const sandboxes = registryWith({}, stuck)
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      const commitPattern = '[0-9a-f]{40}'
      await expect(sandboxes.push(alice, sandbox.id, 'agent/stuck', author, allowed)).rejects.toMatchObject({
        status: 502,
        message: expect.stringMatching(new RegExp(`^pushed ${commitPattern} to agent/stuck, but could not move`)),
      })
      expect(sandboxes.get(alice, sandbox.id)?.pushed).toEqual({
        'agent/stuck': git(repository, 'rev-parse', 'agent/stuck'),
      })
    })

    it('tells the caller why the remote refused the push', async () => {
      // as GitHub refuses an app without the workflows permission: the reason is on the ref
      writeFileSync(join(repository, '.git', 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      const refused = await sandboxes.push(alice, sandbox.id, 'agent/refused', author, allowed).catch((e) => e)
      expect(refused).toMatchObject({
        status: 502,
        message: 'the remote refused the push to agent/refused: [remote rejected] (pre-receive hook declined)',
      })
      expect(git(repository, 'branch', '--list', 'agent/*')).toBe('')
    })

    it('tells the caller neither the branch git refuses nor what the credential provider said', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      for (const branch of ['agent/.x', 'agent/x.', 'agent/x.lock', 'agent/x.lock/y']) {
        await expect(sandboxes.push(alice, sandbox.id, branch, author, allowed)).rejects.toMatchObject({ status: 400 })
      }
      pushCredentialFails = true
      await expect(sandboxes.push(alice, sandbox.id, 'agent/x', author, allowed)).rejects.toMatchObject({
        status: 502,
        message: 'the server could not read its credential to push',
      })
      expect(logged.some((line) => line.includes('secret-vault-7'))).toBe(true)
    })

    it('leaves the write credential nowhere in the sandbox, its records or the commit', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      const pushed = await sandboxes.push(alice, sandbox.id, 'agent/secret', author, allowed)
      expect(JSON.stringify(pushed)).not.toContain(PUSH_TOKEN)
      const written = [...allFiles(join(root, 'files')), ...allFiles(join(root, 'records'))]
      expect(written.some((path) => path.endsWith(join(sandbox.id, 'git', 'config')))).toBe(true)
      expect(written.filter((path) => readFileSync(path).includes(PUSH_TOKEN))).toEqual([])
      expect(git(repository, 'cat-file', '-p', 'agent/secret')).not.toContain(PUSH_TOKEN)
      expect(git(repository, 'format-patch', '--stdout', '-1', 'agent/secret')).not.toContain(PUSH_TOKEN)
    })

    it('does not run the hooks or the config a task wrote into the files when it pushes', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      const files = (await sandboxes.attach(sandbox.id, root)).directory
      const marker = join(root, 'ran')
      mkdirSync(join(files, '.git', 'hooks'), { recursive: true })
      writeFileSync(join(files, '.git', 'config'), `[core]\n\tfsmonitor = touch ${marker}\n`)
      for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction']) {
        writeFileSync(join(files, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
      }
      writeFileSync(join(files, 'input.txt'), 'changed')
      const pushed = await sandboxes.push(alice, sandbox.id, 'agent/hooks', author, allowed)
      expect(pushed.commit).toBe(git(repository, 'rev-parse', 'agent/hooks'))
      expect(existsSync(marker)).toBe(false)
      // nor do they leave the server
      expect(git(repository, 'ls-tree', '-r', '--name-only', 'agent/hooks').split('\n')).toEqual([
        '.gitignore',
        'input.txt',
      ])
    })

    it.each([
      ['refs/heads/main', 403],
      ['agent', 403],
      ['AGENT/x', 403],
      ['Agent/x', 403],
      ['agent/x:main', 400],
      ['+main', 400],
      ['+agent/x', 400],
      ['--force', 400],
      ['-agent/x', 400],
      ['agent/-x', 400],
      ['agent/x@{u}', 400],
      ['agent/x@{1}', 400],
      ['agent/x~1', 400],
      ['agent/x^', 400],
      ['agent/x y', 400],
      ['agent//x', 400],
      ['agent/x/', 400],
      ['agent/*', 400],
      ['agent/x\nmain', 400],
      ['agent/x.lock/y', 400],
    ])('refuses to push to %j with %i', async (branch, status) => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      await expect(sandboxes.push(alice, sandbox.id, branch, author, allowed)).rejects.toMatchObject({ status })
      expect(git(repository, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(
        'refs/heads/main\nrefs/heads/next'
      )
    })

    it('answers 502 and leaves the sandbox as it is when it can not read the remote', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      const reachable = repository
      repository = join(root, 'gone')
      await expect(sandboxes.push(alice, sandbox.id, 'agent/x', author, allowed)).rejects.toMatchObject({ status: 502 })
      expect(sandboxes.get(alice, sandbox.id)).toMatchObject({ commit: first, ref: 'main' })
      expect(sandboxes.get(alice, sandbox.id)?.pushed).toBeUndefined()
      expect(await sandboxes.state(sandbox.id)).toMatchObject({ commit: first, clean: false })

      // the push fails, and the branch can not be read again after it either
      repository = reachable
      const storage = new HostSandboxStorage(join(root, 'files'), process.env)
      const failing: SandboxStorage = Object.create(storage)
      failing.push = async () => {
        repository = join(root, 'gone')
        throw new Error('the remote hung up')
      }
      const broken = registryWith({}, failing)
      await broken.load()
      await expect(broken.push(alice, sandbox.id, 'agent/x', author, allowed)).rejects.toMatchObject({
        status: 502,
        message: 'the remote hung up',
      })
      expect(broken.get(alice, sandbox.id)).toMatchObject({ commit: first, ref: 'main' })
      expect(broken.get(alice, sandbox.id)?.pushed).toBeUndefined()
    })

    it('does not push while a run holds the sandbox, nor a sandbox without changes', async () => {
      const sandboxes = registryWith()
      const sandbox = await sandboxes.create(alice, REPO, 'main')
      await expect(sandboxes.push(alice, sandbox.id, 'agent/x', author, allowed)).rejects.toMatchObject({
        status: 409,
        message: `the sandbox ${sandbox.id} has no changes to push`,
      })
      // only what the API never reads changed
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, '.env'), 'TOKEN=s3cret')
      await expect(sandboxes.push(alice, sandbox.id, 'agent/x', author, allowed)).rejects.toMatchObject({ status: 409 })
      writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'input.txt'), 'changed')
      holder = 'run_1'
      await expect(sandboxes.push(alice, sandbox.id, 'agent/x', author, allowed)).rejects.toMatchObject({
        status: 409,
        message: `the run run_1 holds the sandbox ${sandbox.id}, wait for it to finish or cancel it`,
      })
      expect(git(repository, 'branch', '--list', 'agent/*')).toBe('')
    })
  })

  it("does not hold up a run's result for its measure, but the owner's next run waits for it", async () => {
    const sandboxes = registryWith({ bytes: 1024 * 1024 })
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    writeFileSync(join((await sandboxes.attach(sandbox.id, root)).directory, 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
    // what the executor does once the run is over, without waiting
    const measuring = sandboxes.measure(sandbox.id)
    await sandboxes.measured(alice)
    expect(sandboxes.overLimit(alice)).toMatch(/more than your limit of 1Mi/)
    await measuring
  })
})
