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

// The checkout a directory is in: the repository of its `origin`, the branch it is on and
// its commit, what can be found of them.
export async function readCheckout(cwd: string): Promise<{ repo?: string; branch?: string; commit?: string }> {
  if ((await git(cwd, 'rev-parse', '--is-inside-work-tree')) !== 'true') {
    return {}
  }
  const remote = await git(cwd, 'remote', 'get-url', 'origin')
  // a detached HEAD is on no branch
  const branch = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  return { repo: remote ? remoteRepo(remote) : undefined, branch, commit: await git(cwd, 'rev-parse', 'HEAD') }
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
