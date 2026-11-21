import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { hostname, tmpdir } from 'os'
import { dirname, join } from 'path'
import { createGitRepo } from '../testing/git-repo'
import { applyAnnotations, collectAnnotations, readCheckout, remoteRepo } from './annotations'

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
        branch: 'main',
        commit,
        machine: hostname(),
      })
      expect(annotations.user).toBeTruthy()
    } finally {
      repo.remove()
    }
  })

  it('names the branch checked out, on a detached HEAD the one of a pull request job', async () => {
    const repo = createGitRepo()
    const fileName = join(repo.path, '.hammerkit.yaml')
    try {
      const commit = repo.commit({ '.hammerkit.yaml': 'tasks: {}\n' })
      execFileSync('git', ['checkout', '--quiet', '-b', 'feat/x'], { cwd: repo.path })
      expect(await collectAnnotations(fileName, undefined, {})).toMatchObject({ branch: 'feat/x' })
      execFileSync('git', ['checkout', '--quiet', '--detach', commit], { cwd: repo.path })
      expect(await collectAnnotations(fileName, undefined, {})).not.toHaveProperty('branch')
      expect(await collectAnnotations(fileName, undefined, { GITHUB_HEAD_REF: 'feat/y' })).toMatchObject({
        branch: 'feat/y',
      })
    } finally {
      repo.remove()
    }
  })

  it('says when a file of the bundle is not as the commit has it', async () => {
    const repo = createGitRepo()
    const fileName = join(repo.path, 'web', '.hammerkit.yaml')
    const files = ['.hammerkit.yaml', 'more.yaml']
    try {
      const commit = repo.commit({
        'web/.hammerkit.yaml': 'includes:\n  more: ./more.yaml\n',
        'web/more.yaml': 'tasks: {}\n',
        'README.md': 'hi\n',
      })
      expect(await collectAnnotations(fileName, files)).not.toHaveProperty('dirty')

      // a change outside of the bundle is not one of the version
      writeFileSync(join(repo.path, 'README.md'), 'changed\n')
      expect(await collectAnnotations(fileName, files)).not.toHaveProperty('dirty')

      writeFileSync(join(repo.path, 'web', 'more.yaml'), 'tasks:\n  lint:\n    cmds: [echo lint]\n')
      expect(await collectAnnotations(fileName, files)).toMatchObject({ commit, dirty: 'true' })

      // a file the commit does not have at all
      repo.commit({ 'web/more.yaml': 'tasks: {}\n' })
      writeFileSync(join(repo.path, 'web', 'new.yaml'), 'tasks: {}\n')
      expect(await collectAnnotations(fileName, [...files, 'new.yaml'])).toMatchObject({ dirty: 'true' })
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

describe('readCheckout', () => {
  it('lists the branches of origin and the tags at the commit of a detached checkout', async () => {
    const repo = createGitRepo()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.path, stdio: 'pipe' })
    try {
      const commit = repo.commit({ 'a.txt': 'a' })
      git('remote', 'add', 'origin', 'https://github.com/corp/payments.git')
      // on a branch: that branch, and no heads
      expect(await readCheckout(repo.path)).toEqual({ repo: 'github.com/corp/payments', branch: 'main', commit })

      git('checkout', '-q', '--detach')
      git('update-ref', 'refs/remotes/origin/agent/fix', commit)
      // a branch and a tag of the same name stay two heads
      git('tag', 'agent/fix')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', '-m', 'release', 'v1')
      // origin/HEAD is no branch of its own, as a symbolic ref or not
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/agent/fix')
      // a name the server would take for a commit
      git('update-ref', `refs/remotes/origin/${'a'.repeat(40)}`, commit)
      git('tag', 'b'.repeat(64))
      // and what is not at the commit
      const later = repo.commit({ 'b.txt': 'b' })
      git('update-ref', 'refs/remotes/origin/moved', later)
      git('checkout', '-q', commit)

      expect(await readCheckout(repo.path)).toEqual({
        repo: 'github.com/corp/payments',
        commit,
        heads: [
          { name: 'agent/fix', kind: 'branch' },
          { name: 'agent/fix', kind: 'tag' },
          { name: 'v1', kind: 'tag' },
        ],
      })

      git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
      git('update-ref', '--no-deref', 'refs/remotes/origin/HEAD', commit)
      expect((await readCheckout(repo.path)).heads?.map((head) => head.name)).toEqual(['agent/fix', 'agent/fix', 'v1'])
    } finally {
      repo.remove()
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
