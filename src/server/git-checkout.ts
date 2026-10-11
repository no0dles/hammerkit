import { execFile } from 'child_process'
import { mkdir } from 'fs/promises'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Anything but plain network and local transports is refused: `ext::` runs a command.
const ALLOWED_PROTOCOLS = 'file:git:http:https:ssh'

// A branch, a tag or a commit. It is passed after `--` as well, but a ref that
// looks like an option, has a `..` or odd characters is not one of the three.
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

export function isValidRef(ref: string): boolean {
  return (
    REF_PATTERN.test(ref) && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.lock')
  )
}

/**
 * Fetches one commit of a repository into `directory` and checks it out, and
 * answers which commit that is. The repository is the operator's, the ref is the
 * caller's. Credentials come from the git configuration of the server, there is no
 * prompt a run could hang on.
 */
export async function checkoutRef(
  repository: string,
  ref: string,
  directory: string,
  env: { [key: string]: string | undefined },
  signal: AbortSignal,
  // the commit the ref was resolved to when the run was submitted: a ref that moved since
  // is not what was approved
  expectedCommit?: string
): Promise<string> {
  if (!isValidRef(ref)) {
    throw new Error(`${JSON.stringify(ref.slice(0, 80))} is not a branch, tag or commit`)
  }
  await mkdir(directory, { recursive: true })
  const run = (args: string[]) => git(args, env, signal, `${repository} at ${ref}`)
  await run(['init', '--quiet', directory])
  await run(['-C', directory, 'fetch', '--quiet', '--depth', '1', '--', repository, ref])
  await run(['-C', directory, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'])
  const commit = (await run(['-C', directory, 'rev-parse', 'HEAD'])).trim()
  if (expectedCommit && commit !== expectedCommit) {
    throw new Error(`${ref} is at ${commit} now, the run was submitted for ${expectedCommit}`)
  }
  return commit
}

export class RefError extends Error {}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * The commit a branch or tag of a repository points to now: `refs/heads/<ref>`, else
 * `refs/tags/<ref>` (the commit of an annotated tag). A name that is both a branch and
 * a tag is ambiguous. A full commit hash is taken as it is.
 */
export async function resolveRef(
  repository: string,
  ref: string,
  env: { [key: string]: string | undefined },
  signal: AbortSignal
): Promise<string> {
  if (!isValidRef(ref)) {
    throw new RefError(`${JSON.stringify(ref.slice(0, 80))} is not a branch, tag or commit`)
  }
  if (COMMIT.test(ref.toLowerCase())) {
    return ref.toLowerCase()
  }
  const output = await git(
    [
      'ls-remote',
      '--heads',
      '--tags',
      '--',
      repository,
      `refs/heads/${ref}`,
      `refs/tags/${ref}`,
      `refs/tags/${ref}^{}`,
    ],
    env,
    signal,
    `the refs of ${repository}`
  )
  const found = new Map<string, string>()
  for (const line of output.split('\n')) {
    const [commit, name] = line.split('\t')
    if (commit && name) {
      found.set(name, commit)
    }
  }
  const branch = found.get(`refs/heads/${ref}`)
  const tag = found.get(`refs/tags/${ref}^{}`) ?? found.get(`refs/tags/${ref}`)
  if (branch && tag) {
    throw new RefError(`${ref} is both a branch and a tag, name one of them`)
  }
  const commit = branch ?? tag
  if (!commit) {
    throw new RefError(`there is no branch or tag ${ref}`)
  }
  return commit
}

async function git(
  args: string[],
  baseEnv: { [key: string]: string | undefined },
  signal: AbortSignal,
  what: string
): Promise<string> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ALLOW_PROTOCOL = ALLOWED_PROTOCOLS
  try {
    return (await execFileAsync('git', args, { env, signal })).stdout
  } catch (e) {
    const error = e as NodeJS.ErrnoException & { stderr?: string }
    if (error.code === 'ABORT_ERR') {
      throw new Error(`fetching ${what} was cancelled`)
    }
    if (error.code === 'ENOENT') {
      throw new Error(`unable to fetch ${what}: git is not installed`)
    }
    const reason =
      (error.stderr ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop() ?? error.message
    throw new Error(`unable to fetch ${what}: ${reason}`)
  }
}
