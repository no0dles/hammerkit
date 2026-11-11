/**
 * Where a repository (`host/path`, as runs name it), a branch or tag of it and a commit are
 * on the web. GitHub, GitLab and Bitbucket are known by their host: `github.com` or a
 * `github.` host (GitHub Enterprise), a host with `gitlab` in it, `bitbucket.org`. Of any
 * other host only the repository is linked, at `https://<host>/<path>`.
 */
export interface WebLinks {
  repo: string
  ref?: (ref: string) => string
  commit?: (commit: string) => string
}

const REPO = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)+$/
const COMMIT = /^[0-9a-f]{7,64}$/

// a branch keeps its slashes, as the forges read them; the rest of each part is encoded
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/')

export function webLinks(repo: string): WebLinks | undefined {
  if (!REPO.test(repo)) {
    return undefined
  }
  const base = `https://${repo}`
  const host = repo
    .split('/')[0]
    .replace(/:[0-9]+$/, '')
    .toLowerCase()
  const forge = (tree: string, commits: string): WebLinks => ({
    repo: base,
    ref: (ref) => `${base}/${tree}/${refPath(ref)}`,
    commit: (commit) => (COMMIT.test(commit) ? `${base}/${commits}/${commit}` : base),
  })
  if (host === 'github.com' || host.startsWith('github.')) {
    return forge('tree', 'commit')
  }
  if (host.split('.').some((label) => label.includes('gitlab'))) {
    return forge('-/tree', '-/commit')
  }
  if (host === 'bitbucket.org') {
    return forge('src', 'commits')
  }
  return { repo: base }
}
