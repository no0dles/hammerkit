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
import { HostSandboxStorage } from './sandbox-storage'
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

describe('SandboxRegistry', () => {
  let root: string
  let repository: string
  let first: string
  let second: string
  let holder: string | undefined
  let stopped: string[]

  const registryWith = (limits: Partial<SandboxLimits> = {}) => {
    const sandboxes = new SandboxRegistry({
      storage: new HostSandboxStorage(join(root, 'files'), process.env),
      records: join(root, 'records'),
      limits: { count: 5, bytes: 100 * 1024 * 1024, total: 1024 * 1024 * 1024, ...limits },
      repos: {
        url: () => repository,
        credentials: async () => ({ env: { ...(process.env as { [key: string]: string }) }, values: ['s3cret'] }),
        resolve: (_repo, ref, signal, only) =>
          resolveRef(repository, ref, process.env, signal ?? AbortSignal.timeout(60_000), only),
        scrub: (e) => (e instanceof Error ? e : new Error(String(e))),
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
    const files = await sandboxes.attach(sandbox.id)
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
    const files = await sandboxes.attach(sandbox.id)
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
    const files = await sandboxes.attach(sandbox.id)
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
    const files = await sandboxes.attach(sandbox.id)
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
    expect(readFileSync(join(await sandboxes.attach(sandbox.id), 'input.txt'), 'utf8')).toBe('two')
  })

  it('does not move a sandbox with changes, nor one a run holds', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    writeFileSync(join(await sandboxes.attach(sandbox.id), 'input.txt'), 'changed')
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
      writeFileSync(join(await sandboxes.attach(sandbox.id), 'input.txt'), 'onx')
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
        resolve: async (_repo, ref) => git(repository, 'rev-parse', ref),
        scrub: (e) => (e instanceof Error ? e : new Error(String(e))),
      },
    })
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    const files = await sandboxes.attach(sandbox.id)
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
      const files = await sandboxes.attach(sandbox.id)
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
    await storage.create('sbx_large', { url: repository, ref: 'main', env: process.env as any, signal })
    const files = await storage.attach('sbx_large')
    const before = await storage.usage('sbx_large')
    // what `npm ci` leaves: ignored, and tens of thousands of files in a real project
    for (let pkg = 0; pkg < 40; pkg++) {
      mkdirSync(join(files, 'node_modules', `pkg-${pkg}`, 'lib'), { recursive: true })
      for (let file = 0; file < 250; file++) {
        writeFileSync(join(files, 'node_modules', `pkg-${pkg}`, 'lib', `${file}.js`), 'x'.repeat(10))
      }
    }
    const walk = vi.spyOn(storage as any, 'walk')
    // what a run ends with
    expect(await storage.usage('sbx_large')).toBe(before + 40 * 250 * 10)
    expect(walk).toHaveBeenCalledTimes(1)
    // the next run is submitted and starts on what that walk left: nothing ran in between
    expect(await storage.state('sbx_large')).toMatchObject({ clean: true })
    expect(await storage.state('sbx_large')).toMatchObject({ clean: true })
    expect(walk).toHaveBeenCalledTimes(1)
    // while it runs, its tasks write: a state then walks, and so does the one after
    await storage.attach('sbx_large')
    writeFileSync(join(files, 'new.txt'), 'new')
    chmodSync(join(files, 'new.txt'), 0o000)
    expect(await storage.state('sbx_large')).toMatchObject({ clean: false })
    expect(await storage.state('sbx_large')).toMatchObject({ clean: false })
    expect(walk).toHaveBeenCalledTimes(3)
    // until its measure: one walk per run
    await storage.usage('sbx_large')
    expect(await storage.state('sbx_large')).toMatchObject({ clean: false })
    expect(walk).toHaveBeenCalledTimes(4)
  }, 60_000)

  it('reads the files of an edit without walking them again', async () => {
    const storage = new HostSandboxStorage(join(root, 'files'), process.env)
    const signal = AbortSignal.timeout(60_000)
    await storage.create('sbx_edit', { url: repository, ref: 'main', env: process.env as any, signal })
    const files = await storage.attach('sbx_edit')
    // a run left a link, and was measured
    mkdirSync(join(files, 'dir'))
    symlinkSync(join(files, 'dir'), join(files, 'link'), 'junction')
    await storage.usage('sbx_edit')
    const walk = vi.spyOn(storage as any, 'walk')
    const edits = storage.files('sbx_edit')
    await (await edits.plan([{ op: 'delete', path: 'link' }])).commit()
    await (await edits.plan([{ op: 'write', path: 'link', content: 'a file now\n' }])).commit()
    expect(await edits.changes()).toEqual([{ path: 'link', status: 'added', additions: 1, deletions: 0 }])
    expect(await storage.state('sbx_edit')).toMatchObject({ clean: false })
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
    writeFileSync(join(await sandboxes.attach(sandbox.id), 'big.bin'), Buffer.alloc(64 * 1024))
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

  it("does not hold up a run's result for its measure, but the owner's next run waits for it", async () => {
    const sandboxes = registryWith({ bytes: 1024 * 1024 })
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    writeFileSync(join(await sandboxes.attach(sandbox.id), 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
    // what the executor does once the run is over, without waiting
    const measuring = sandboxes.measure(sandbox.id)
    await sandboxes.measured(alice)
    expect(sandboxes.overLimit(alice)).toMatch(/more than your limit of 1Mi/)
    await measuring
  })
})
