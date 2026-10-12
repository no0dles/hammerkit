import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RefError } from './git-checkout'
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
        resolve: async (_repo, ref) => {
          if (ref === 'missing') {
            throw new RefError('there is no branch or tag missing')
          }
          return git(repository, 'rev-parse', ref)
        },
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
      message: 'there is no branch or tag missing',
    })
    expect(sandboxes.usage(alice)).toEqual({ count: 0, bytes: 0 })
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

  it('measures what a run wrote', async () => {
    const sandboxes = registryWith()
    const sandbox = await sandboxes.create(alice, REPO, 'main')
    writeFileSync(join(await sandboxes.attach(sandbox.id), 'big.bin'), Buffer.alloc(64 * 1024))
    await sandboxes.measure(sandbox.id)
    expect(sandboxes.get(alice, sandbox.id)?.bytes).toBeGreaterThanOrEqual(sandbox.bytes + 64 * 1024)
    expect(registryWith({ bytes: sandbox.bytes }).overLimit(alice)).toBeUndefined()
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
})
