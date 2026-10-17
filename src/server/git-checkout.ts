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

export class GitOutputTooLarge extends Error {}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * The commit a branch or tag of a repository points to now: `refs/heads/<ref>`, else
 * `refs/tags/<ref>` (the commit of an annotated tag). A name that is both a branch and
 * a tag is ambiguous. A full commit hash is taken as it is. With `branch`, only a
 * branch: a sandbox starts from one.
 */
export async function resolveRef(
  repository: string,
  ref: string,
  env: { [key: string]: string | undefined },
  signal: AbortSignal,
  only?: 'branch'
): Promise<string> {
  if (only === 'branch') {
    return resolveBranch(repository, ref, env, signal)
  }
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

async function resolveBranch(
  repository: string,
  branch: string,
  env: { [key: string]: string | undefined },
  signal: AbortSignal
): Promise<string> {
  assertBranchName(branch)
  const output = await git(
    ['ls-remote', '--heads', '--', repository, `refs/heads/${branch}`],
    env,
    signal,
    `the branches of ${repository}`
  )
  const commit = output
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([, name]) => name === `refs/heads/${branch}`)?.[0]
  if (!commit) {
    throw new RefError(`there is no branch ${branch}`)
  }
  return commit
}

// A name a sandbox can start from: a branch, never a tag or a commit, written without `refs/heads/`.
export function assertBranchName(branch: string): void {
  if (!isValidRef(branch) || branch.startsWith('refs/')) {
    throw new RefError(`${JSON.stringify(branch.slice(0, 80))} is not a branch`)
  }
  if (COMMIT.test(branch.toLowerCase())) {
    throw new RefError(`a sandbox starts from a branch, ${branch} is a commit`)
  }
}

// Runs git without a prompt and with the network transports only. Errors say what could
// not be done (`unable to <action> <what>`) with the last line git printed.
export async function git(
  args: string[],
  baseEnv: { [key: string]: string | undefined },
  signal: AbortSignal,
  what: string,
  action = 'fetch',
  // what git reads on stdin, the exit codes that answer rather than fail (check-ignore exits
  // 1 when nothing is ignored), and what git may print (a diff of a sandbox can be larger
  // than the default)
  options: { input?: string | Buffer; exitCodes?: number[]; maxBuffer?: number } = {}
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
    // warnings of a large tree must not fail the command
    const running = execFileAsync('git', args, { env, signal, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024 })
    // a git that exits before it read its input fails the command, not the server (EPIPE)
    running.child.stdin?.on('error', () => undefined)
    running.child.stdin?.end(options.input)
    return (await running).stdout
  } catch (e) {
    const error = e as Omit<NodeJS.ErrnoException, 'code'> & {
      code?: string | number
      stdout?: string
      stderr?: string
    }
    if (typeof error.code === 'number' && options.exitCodes?.includes(error.code)) {
      return error.stdout ?? ''
    }
    if (error.code === 'ABORT_ERR') {
      throw new Error(`${action === 'fetch' ? 'fetching' : `${action} of`} ${what} was cancelled`)
    }
    if (error.code === 'ENOENT') {
      throw new Error(`unable to ${action} ${what}: git is not installed`)
    }
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new GitOutputTooLarge(
        `unable to ${action} ${what}: git printed more than ${options.maxBuffer ?? 64 * 1024 * 1024} bytes`
      )
    }
    const reason =
      (error.stderr ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop() ?? error.message
    throw new Error(`unable to ${action} ${what}: ${reason}`)
  }
}
