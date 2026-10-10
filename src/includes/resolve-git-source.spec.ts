import { readFileSync } from 'fs'
import { join } from 'path'
import { environmentMock } from '../executer/environment-mock'
import { createGitRepo, GitRepo, isolateHammerkitHome } from '../testing/git-repo'
import { resolveGitSource } from './resolve-git-source'

describe('resolveGitSource', () => {
  let repo: GitRepo
  let home: ReturnType<typeof isolateHammerkitHome>
  const environment = environmentMock(process.cwd())

  beforeEach(() => {
    home = isolateHammerkitHome()
    repo = createGitRepo()
  })
  afterEach(() => {
    repo.remove()
    home.restore()
  })

  const read = (root: string, fileName: string) => readFileSync(join(root, fileName), 'utf8')

  it('fetches the repository HEAD when no ref is given', async () => {
    const commit = repo.commit({ 'build.yaml': 'v1' })

    const resolved = await resolveGitSource({ git: repo.url }, environment)

    expect(resolved.commit).toBe(commit)
    expect(resolved.ref).toBeNull()
    expect(read(resolved.root, 'build.yaml')).toBe('v1')
  })

  it('resolves a branch, a tag and a commit SHA', async () => {
    const first = repo.commit({ 'build.yaml': 'first' })
    repo.tag('v1')
    repo.commit({ 'build.yaml': 'second' })
    repo.branch('feature')
    repo.commit({ 'build.yaml': 'third' })

    const tag = await resolveGitSource({ git: repo.url, ref: 'v1' }, environment)
    const branch = await resolveGitSource({ git: repo.url, ref: 'feature' }, environment)
    const sha = await resolveGitSource({ git: repo.url, ref: first }, environment)

    expect(read(tag.root, 'build.yaml')).toBe('first')
    expect(read(branch.root, 'build.yaml')).toBe('second')
    expect(read(sha.root, 'build.yaml')).toBe('first')
    expect(sha.commit).toBe(first)
  })

  it('uses the cached checkout without the repository, so a build runs offline', async () => {
    repo.commit({ 'build.yaml': 'v1' })
    const online = await resolveGitSource({ git: repo.url, ref: 'main' }, environment)

    repo.remove()
    const offline = await resolveGitSource({ git: repo.url, ref: 'main' }, environment)

    expect(offline).toEqual(online)
    expect(read(offline.root, 'build.yaml')).toBe('v1')
  })

  it('keeps a branch at the cached commit when upstream advances (the cache is the pin)', async () => {
    const first = repo.commit({ 'build.yaml': 'v1' })
    await resolveGitSource({ git: repo.url, ref: 'main' }, environment)

    repo.commit({ 'build.yaml': 'v2' })
    const again = await resolveGitSource({ git: repo.url, ref: 'main' }, environment)

    expect(again.commit).toBe(first)
    expect(read(again.root, 'build.yaml')).toBe('v1')
  })

  it('pins a commit SHA to identical content regardless of the cache', async () => {
    const first = repo.commit({ 'build.yaml': 'v1' })
    repo.commit({ 'build.yaml': 'v2' })

    const resolved = await resolveGitSource({ git: repo.url, ref: first }, environment)

    expect(resolved.commit).toBe(first)
    expect(read(resolved.root, 'build.yaml')).toBe('v1')
  })

  it('names the repository and ref when an uncached source is unreachable', async () => {
    repo.commit({ 'build.yaml': 'v1' })
    repo.remove()

    await expect(resolveGitSource({ git: repo.url, ref: 'main' }, environment)).rejects.toThrow(
      `unable to resolve ${repo.url} at main`
    )
  })

  it('names the ref when it does not exist in the repository', async () => {
    repo.commit({ 'build.yaml': 'v1' })

    await expect(resolveGitSource({ git: repo.url, ref: 'missing' }, environment)).rejects.toThrow(
      `unable to resolve ${repo.url} at missing`
    )
  })

  it('does not leave a partial entry behind after a failed fetch', async () => {
    repo.commit({ 'build.yaml': 'v1' })
    await expect(resolveGitSource({ git: repo.url, ref: 'missing' }, environment)).rejects.toThrow()

    // the same source resolves once the ref exists
    repo.branch('missing')
    const resolved = await resolveGitSource({ git: repo.url, ref: 'missing' }, environment)
    expect(read(resolved.root, 'build.yaml')).toBe('v1')
  })

  it('refuses transports that run commands', async () => {
    await expect(resolveGitSource({ git: 'ext::sh -c touch% pwned' }, environment)).rejects.toThrow(
      /unable to resolve ext::sh/
    )
  })
})
