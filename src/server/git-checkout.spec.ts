import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkoutRef, isValidRef, RefError, resolveRef } from './git-checkout'

const env = { PATH: process.env.PATH, HOME: process.env.HOME }

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  )
}

describe('isValidRef', () => {
  it('takes branches, tags and commits', () => {
    for (const ref of ['main', 'release/1.2', 'v1.2.3', 'feature_x-1', 'a'.repeat(40)]) {
      expect(isValidRef(ref)).toBe(true)
    }
  })

  it('refuses what looks like an option or is not a name', () => {
    for (const ref of [
      '',
      '-x',
      '--upload-pack=sh',
      '../x',
      'a..b',
      'a//b',
      'a/',
      'a.lock',
      'a b',
      'a;b',
      'a\nb',
      'a'.repeat(201),
    ]) {
      expect(isValidRef(ref)).toBe(false)
    }
  })
})

describe('checkoutRef', () => {
  let root: string
  let repository: string
  let commit: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-checkout-'))
    repository = join(root, 'repository')
    git(root, 'init', '--quiet', '--initial-branch=main', repository)
    writeFileSync(join(repository, 'a.txt'), 'one')
    git(repository, 'add', '.')
    git(repository, 'commit', '--quiet', '-m', 'one')
    git(repository, 'tag', 'v1')
    writeFileSync(join(repository, 'a.txt'), 'two')
    git(repository, 'commit', '--quiet', '-am', 'two')
    commit = git(repository, 'rev-parse', 'HEAD').trim()
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('checks out a branch, a tag and a commit', async () => {
    const signal = new AbortController().signal
    expect(await checkoutRef(repository, 'main', join(root, 'b'), env, signal)).toBe(commit)
    expect(readFileSync(join(root, 'b', 'a.txt'), 'utf8')).toBe('two')
    expect(await checkoutRef(repository, 'v1', join(root, 't'), env, signal)).not.toBe(commit)
    expect(readFileSync(join(root, 't', 'a.txt'), 'utf8')).toBe('one')
    // fetching a commit by its hash needs the server to allow it, which a local one does
    git(repository, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    expect(await checkoutRef(repository, commit, join(root, 'c'), env, signal)).toBe(commit)
  })

  it('says which ref could not be fetched, without an option getting through', async () => {
    const signal = new AbortController().signal
    await expect(checkoutRef(repository, 'nope', join(root, 'x'), env, signal)).rejects.toThrow(
      /unable to fetch .* at nope/
    )
    await expect(checkoutRef(repository, '--upload-pack=touch pwned', join(root, 'y'), env, signal)).rejects.toThrow(
      'is not a branch, tag or commit'
    )
    expect(existsSync(join(root, 'y'))).toBe(false)
    expect(existsSync(join(root, 'pwned'))).toBe(false)
  })

  it('fails when the ref moved from the commit the run was submitted for', async () => {
    const signal = new AbortController().signal
    const submitted = commit
    writeFileSync(join(repository, 'a.txt'), 'three')
    git(repository, 'commit', '--quiet', '-am', 'three')
    await expect(checkoutRef(repository, 'main', join(root, 'm'), env, signal, submitted)).rejects.toThrow(
      `the run was submitted for ${submitted}`
    )
    const now = git(repository, 'rev-parse', 'HEAD').trim()
    expect(await checkoutRef(repository, 'main', join(root, 'n'), env, signal, now)).toBe(now)
  })

  it('does not run a command through a transport', async () => {
    const signal = new AbortController().signal
    await expect(
      checkoutRef(`ext::sh -c "touch ${join(root, 'pwned')}"`, 'main', join(root, 'z'), env, signal)
    ).rejects.toThrow('unable to fetch')
    expect(existsSync(join(root, 'pwned'))).toBe(false)
  })

  it('stops when cancelled', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(checkoutRef(repository, 'main', join(root, 'w'), env, abort.signal)).rejects.toThrow('cancelled')
  })
})

describe('resolveRef', () => {
  let root: string
  let repository: string
  let commit: string
  const signal = new AbortController().signal

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-resolve-'))
    repository = join(root, 'repository')
    git(root, 'init', '--quiet', '--initial-branch=main', repository)
    writeFileSync(join(repository, 'a.txt'), 'one')
    git(repository, 'add', '.')
    git(repository, 'commit', '--quiet', '-m', 'one')
    commit = git(repository, 'rev-parse', 'HEAD').trim()
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('answers the commit of a branch, a tag and an annotated tag', async () => {
    git(repository, 'branch', 'release/1.2')
    git(repository, 'tag', 'v1')
    git(repository, 'tag', '-a', 'v2', '-m', 'annotated')
    expect(await resolveRef(repository, 'main', env, signal)).toBe(commit)
    expect(await resolveRef(repository, 'release/1.2', env, signal)).toBe(commit)
    expect(await resolveRef(repository, 'v1', env, signal)).toBe(commit)
    // the commit of the tag, not the tag object
    expect(await resolveRef(repository, 'v2', env, signal)).toBe(commit)
  })

  it('takes a full commit as it is and does not ask the repository', async () => {
    expect(await resolveRef(join(root, 'nowhere'), commit.toUpperCase(), env, signal)).toBe(commit)
  })

  it('says when there is no such ref, or when the name is a branch and a tag', async () => {
    await expect(resolveRef(repository, 'nope', env, signal)).rejects.toThrow('there is no branch or tag nope')
    git(repository, 'tag', 'main')
    const error = await resolveRef(repository, 'main', env, signal).catch((e) => e)
    expect(error).toBeInstanceOf(RefError)
    expect(error.message).toContain('both a branch and a tag')
  })

  it('does not let a ref pass as an option or a pattern', async () => {
    for (const ref of ['--upload-pack=sh', '-x', 'a..b', 'refs/heads/*']) {
      await expect(resolveRef(repository, ref, env, signal)).rejects.toBeInstanceOf(RefError)
    }
  })

  it('says when the repository can not be read', async () => {
    await expect(resolveRef(join(root, 'nowhere'), 'main', env, signal)).rejects.toThrow('unable to fetch')
  })
})
