import { webLinks } from './web-links'

describe('webLinks', () => {
  it('links a repository, a branch and a commit on GitHub, GitLab and Bitbucket', () => {
    const github = webLinks('github.com/no0dles/iwentsourcing')
    expect(github?.repo).toBe('https://github.com/no0dles/iwentsourcing')
    expect(github?.ref?.('claude/hammerkit-build-file')).toBe(
      'https://github.com/no0dles/iwentsourcing/tree/claude/hammerkit-build-file'
    )
    expect(github?.commit?.('c7588e7e57e0aa')).toBe('https://github.com/no0dles/iwentsourcing/commit/c7588e7e57e0aa')
    // GitHub Enterprise
    expect(webLinks('github.corp.com/team/app')?.ref?.('main')).toBe('https://github.corp.com/team/app/tree/main')

    const gitlab = webLinks('gitlab.corp.com/group/sub/project')
    expect(gitlab?.ref?.('feat/x')).toBe('https://gitlab.corp.com/group/sub/project/-/tree/feat/x')
    expect(gitlab?.commit?.('abcdef1')).toBe('https://gitlab.corp.com/group/sub/project/-/commit/abcdef1')

    const bitbucket = webLinks('bitbucket.org/team/repo')
    expect(bitbucket?.ref?.('main')).toBe('https://bitbucket.org/team/repo/src/main')
    expect(bitbucket?.commit?.('abcdef1')).toBe('https://bitbucket.org/team/repo/commits/abcdef1')
  })

  it('links only the repository of another host, and nothing of what is not a repository', () => {
    expect(webLinks('git.corp.com/team/app')).toEqual({ repo: 'https://git.corp.com/team/app' })
    expect(webLinks('an upload')).toBeUndefined()
    expect(webLinks('javascript:alert(1)')).toBeUndefined()
    expect(webLinks('github.com')).toBeUndefined()
    expect(webLinks('github.com/a/b?x=1')).toBeUndefined()
  })

  it('keeps what a ref or commit holds from leaving its place in the path', () => {
    const github = webLinks('github.com/a/b')
    expect(github?.ref?.('feat/#1 ?x')).toBe('https://github.com/a/b/tree/feat/%231%20%3Fx')
    // not a commit: the repository instead
    expect(github?.commit?.('../../evil')).toBe('https://github.com/a/b')
  })
})
