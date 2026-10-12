import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { hostname, tmpdir } from 'os'
import { dirname, join } from 'path'
import { createGitRepo } from '../testing/git-repo'
import { applyAnnotations, collectAnnotations, remoteRepo } from './annotations'

describe('remoteRepo', () => {
  it('names a repository by host and path, whichever way git reaches it', () => {
    expect(remoteRepo('https://github.com/corp/payments.git')).toBe('github.com/corp/payments')
    expect(remoteRepo('git@github.com:corp/payments.git')).toBe('github.com/corp/payments')
    expect(remoteRepo('ssh://git@gitlab.corp.com/platform/team/tool.git')).toBe('gitlab.corp.com/platform/team/tool')
  })

  it('leaves out what it can not name without what else the url carries', () => {
    expect(remoteRepo('https://user:token@github.com/corp/payments.git')).toBe('github.com/corp/payments')
    expect(remoteRepo('file:///srv/repos/payments')).toBeUndefined()
    expect(remoteRepo('/srv/repos/payments')).toBeUndefined()
    expect(remoteRepo('not a url')).toBeUndefined()
  })
})

describe('collectAnnotations', () => {
  it('says where in which repository and commit the build file is, on which machine', async () => {
    const repo = createGitRepo()
    try {
      const commit = repo.commit({ 'web/.hammerkit.yaml': 'tasks: {}\n' })
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:corp/payments.git'], { cwd: repo.path })
      const annotations = await collectAnnotations(join(repo.path, 'web', '.hammerkit.yaml'))
      expect(annotations).toMatchObject({
        path: 'web/.hammerkit.yaml',
        repo: 'github.com/corp/payments',
        commit,
        machine: hostname(),
      })
      expect(annotations.user).toBeTruthy()
    } finally {
      repo.remove()
    }
  })

  it('names the path in the repository however the file system spells the directory', async () => {
    const repo = createGitRepo()
    const link = join(mkdtempSync(join(tmpdir(), 'hammerkit-link-')), 'repo')
    try {
      repo.commit({ 'web/.hammerkit.yaml': 'tasks: {}\n' })
      // another name for the same directory, as a symlink or an 8.3 name on windows is
      symlinkSync(repo.path, link, 'junction')
      expect((await collectAnnotations(join(link, 'web', '.hammerkit.yaml'))).path).toBe('web/.hammerkit.yaml')
    } finally {
      rmSync(dirname(link), { recursive: true, force: true })
      repo.remove()
    }
  })

  it('names the file on this machine outside of a repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-annotations-'))
    try {
      writeFileSync(join(directory, '.hammerkit.yaml'), 'tasks: {}\n')
      const annotations = await collectAnnotations(join(directory, '.hammerkit.yaml'))
      expect(annotations.path).toBe(join(directory, '.hammerkit.yaml'))
      expect(annotations).not.toHaveProperty('repo')
      expect(annotations).not.toHaveProperty('commit')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('applyAnnotations', () => {
  it('sets, replaces and leaves out what the command line says', () => {
    expect(applyAnnotations({ path: 'a', user: 'me' }, ['team=payments', 'user=', 'path=b'])).toEqual({
      path: 'b',
      team: 'payments',
    })
  })

  it('refuses what is not an annotation', () => {
    expect(() => applyAnnotations({}, ['team'])).toThrow('write it as key=value')
    expect(() => applyAnnotations({}, ['=x'])).toThrow('write it as key=value')
    expect(() => applyAnnotations({}, ['Team=x'])).toThrow('annotation Team')
    expect(() => applyAnnotations({}, ['note=' + 'x'.repeat(501)])).toThrow('annotation note')
  })
})
