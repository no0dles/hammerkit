import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkoutRef, isValidRef } from './git-checkout'

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
