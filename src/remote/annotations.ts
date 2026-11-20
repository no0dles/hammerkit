import { execFile } from 'child_process'
import { hostname, userInfo } from 'os'
import { basename, dirname, resolve } from 'path'
import { promisify } from 'util'
import { normalizeRepo } from '../server/repo'
import { Annotations, annotationsSchema } from './bundle'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const value = (await execFileAsync('git', args, { cwd, timeout: 5_000 })).stdout.trim()
    return value || undefined
  } catch {
    return undefined
  }
}

// `host/path` of a remote, or nothing: a url that is neither https, ssh nor
// `user@host:path` is left out, so a credential in it never leaves the machine.
export function remoteRepo(url: string): string | undefined {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(url)
  if (scp) {
    return normalizeRepo(`${scp[1]}/${scp[2]}`) ?? undefined
  }
  try {
    const parsed = new URL(url)
    if (!['https:', 'ssh:'].includes(parsed.protocol)) {
      return undefined
    }
    return normalizeRepo(`${parsed.hostname}${parsed.pathname}`) ?? undefined
  } catch {
    return undefined
  }
}

// a branch or tag of origin whose head is the commit of a detached checkout
export interface CheckoutHead {
  name: string
  kind: 'branch' | 'tag'
}

// what the server takes for a commit, not for the name of a branch or tag
const COMMIT_NAME = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

const ORIGIN_BRANCHES = 'refs/remotes/origin/'
const TAGS = 'refs/tags/'

// The checkout a directory is in: the repository of its `origin`, the branch it is on and
// its commit, what can be found of them. A detached HEAD is on no branch: `heads` are then the
// branches of origin (as the last fetch or push left them) and the tags whose head is its
// commit, branches first, as git sorts them.
export async function readCheckout(
  cwd: string
): Promise<{ repo?: string; branch?: string; commit?: string; heads?: CheckoutHead[] }> {
  if ((await git(cwd, 'rev-parse', '--is-inside-work-tree')) !== 'true') {
    return {}
  }
  const remote = await git(cwd, 'remote', 'get-url', 'origin')
  const repo = remote ? remoteRepo(remote) : undefined
  const branch = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  const commit = await git(cwd, 'rev-parse', 'HEAD')
  if (branch || !commit) {
    return { repo, branch, commit }
  }
  const refs = await git(
    cwd,
    'for-each-ref',
    `--points-at=${commit}`,
    '--format=%(refname)%09%(symref)',
    ORIGIN_BRANCHES,
    TAGS
  )
  const heads: CheckoutHead[] = []
  for (const line of refs?.split('\n') ?? []) {
    const [ref, symref] = line.split('\t')
    // origin/HEAD names the default branch of origin, it is no branch of its own
    if (symref || ref === `${ORIGIN_BRANCHES}HEAD`) {
      continue
    }
    const head: CheckoutHead = ref.startsWith(ORIGIN_BRANCHES)
      ? { name: ref.slice(ORIGIN_BRANCHES.length), kind: 'branch' }
      : { name: ref.slice(TAGS.length), kind: 'tag' }
    // a name that looks like a commit would be run as that commit
    if (head.name && !COMMIT_NAME.test(head.name)) {
      heads.push(head)
    }
  }
  return { repo, commit, heads }
}

// Where a build file is published from: its path in its repository (or on this
// machine, outside of one), the repository and commit, this machine and its user.
// `files` are the paths of the bundle, relative to the build file's directory: when
// one of them differs from the commit, `dirty=true` says the version is not that
// commit's. What can not be found is left out.
export async function collectAnnotations(
  fileName: string,
  files: string[] = [basename(fileName)]
): Promise<Annotations> {
  const path = resolve(fileName)
  const cwd = dirname(path)
  const annotations: Annotations = {}
  // git says where the directory is in the repository: comparing paths would trip on
  // what the file system calls the same directory differently (symlinks, 8.3 names)
  const inside = (await git(cwd, 'rev-parse', '--is-inside-work-tree')) === 'true'
  const prefix = inside ? (await git(cwd, 'rev-parse', '--show-prefix')) ?? '' : undefined
  annotations.path = prefix !== undefined ? `${prefix}${basename(path)}` : path
  if (inside) {
    const remote = await git(cwd, 'remote', 'get-url', 'origin')
    const repo = remote ? remoteRepo(remote) : undefined
    const commit = await git(cwd, 'rev-parse', 'HEAD')
    if (repo) {
      annotations.repo = repo
    }
    if (commit) {
      annotations.commit = commit
      const changed = await git(
        cwd,
        '--literal-pathspecs',
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        ...files
      )
      if (changed) {
        annotations.dirty = 'true'
      }
    }
  }
  annotations.machine = hostname()
  try {
    annotations.user = userInfo().username
  } catch {
    // a user without an entry in the password database
  }
  return Object.fromEntries(Object.entries(annotations).filter(([, value]) => value))
}

// `--annotation key=value` sets one, `key=` leaves it out.
export function applyAnnotations(annotations: Annotations, options: string[]): Annotations {
  const result = { ...annotations }
  for (const option of options) {
    const index = option.indexOf('=')
    if (index <= 0) {
      throw new Error(`${option} is not an annotation, write it as key=value`)
    }
    const key = option.slice(0, index)
    const value = option.slice(index + 1)
    if (value) {
      result[key] = value
    } else {
      delete result[key]
    }
  }
  const parsed = annotationsSchema.safeParse(result)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${issue.path.length > 0 ? `annotation ${issue.path.join('.')}` : 'annotations'}: ${issue.message}`)
  }
  return parsed.data
}
