import { posix, relative, sep, isAbsolute } from 'path'
import type { FileStat, ReadResult, SearchQuery, SearchResult, TreeQuery, TreeResult } from '../server/sandbox-files'
import type { Run, TaskResult } from '../server/runs'
import type { LogPage } from '../server/run-logs'
import { isToken } from '../remote/token-source'

// a write carries up to 32 MiB
const TIMEOUT_MS = 60_000
// a run is asked for this long at a time, the log is read in between
const POLL_WAIT = '1s'

export class SandboxClientError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

// Where the server is and who asks it. The token is read for every call: a short-lived
// token renewed while an agent works is picked up at once.
export interface ServerConnection {
  url: string
  token: () => Promise<string>
  // a 401 asks for a new token once; a token command runs again then
  renew?: () => Promise<void>
}

export interface SandboxView {
  id: string
  repo: string
  ref: string
  commit: string
  bytes: number
  busy: boolean
  run: string | null
}

export type SandboxEdit =
  | { op: 'replace'; path: string; old_string: string; new_string: string; replace_all?: boolean }
  | { op: 'write'; path: string; content: string; encoding?: 'utf8' | 'base64' }
  | { op: 'delete'; path: string }
  | { op: 'move'; path: string; to: string }
  | { op: 'patch'; patch: string }

export interface EditedFile {
  path: string
  change: 'added' | 'modified' | 'deleted'
  sha256?: string
  size?: number
}

export interface ChangedFile {
  path: string
  status: string
  from?: string
  additions: number | null
  deletions: number | null
}

export interface RunTaskOptions {
  args?: string[]
  // how long the task may run, the server stops it then
  timeoutSeconds?: number
  signal?: AbortSignal
  // every line the task prints, as it comes
  onLine?: (text: string) => void
  // the run waits for somebody to approve it
  onWaiting?: (run: Run) => void
}

export interface TaskRun {
  run: Run
  result: TaskResult | undefined
  // what the task printed, as far as the server kept it
  output: string
  // the log of the run was cut off at the server's limit; the last lines of the result
  // still hold the end
  truncated: boolean
  // of the task, or null when it never ran or ended without one
  exitCode: number | null
}

/**
 * A caller's sandbox on a hammerkit server, over its HTTP API: the raw read, write and
 * stat that harnesses plug their own tools into, the typed endpoints for clients without
 * tools of their own, and published tasks run on the files. A shell is such a task: the
 * build file names a task whose last command is `sh -c`, and the command is its argument.
 */
export class SandboxClient {
  constructor(
    readonly connection: ServerConnection,
    readonly sandbox: SandboxView,
    // the published build file whose tasks run on the sandbox, and its shell task
    readonly build: { name: string; shell: string }
  ) {}

  get id(): string {
    return this.sandbox.id
  }

  static async create(connection: ServerConnection, repo: string, ref: string): Promise<SandboxView> {
    return json(await call(connection, 'POST', '/v1/sandboxes', { body: { repo, ref } }))
  }

  static async get(connection: ServerConnection, id: string): Promise<SandboxView> {
    return json(await call(connection, 'GET', `/v1/sandboxes/${encodeURIComponent(id)}`))
  }

  static async list(connection: ServerConnection): Promise<SandboxView[]> {
    return (await json<{ sandboxes: SandboxView[] }>(await call(connection, 'GET', '/v1/sandboxes'))).sandboxes
  }

  // checks out the ref again, what changed in the sandbox is gone
  static async fetch(connection: ServerConnection, id: string, ref: string): Promise<SandboxView> {
    return json(await call(connection, 'POST', `/v1/sandboxes/${encodeURIComponent(id)}/fetch`, { body: { ref } }))
  }

  async stat(path: string): Promise<FileStat | undefined> {
    if (checkSandboxPath(path) === '') {
      // the root is there as long as the sandbox is
      return { path: '', type: 'directory', size: 0, exec: false, modifiedAt: new Date(0).toISOString() }
    }
    const response = await call(this.connection, 'GET', this.file(path), { query: { stat: '' }, missing: true })
    return response.status === 404 ? undefined : json(response)
  }

  async readRaw(path: string): Promise<Buffer> {
    const response = await call(this.connection, 'GET', this.file(path), { query: { raw: '' } })
    if (response.headers.get('x-hammerkit-type') === 'directory') {
      throw new SandboxClientError(`${path} is a directory`, 400)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  async writeRaw(path: string, content: string | Uint8Array): Promise<EditedFile> {
    return json(await call(this.connection, 'PUT', this.file(path), { raw: content }))
  }

  // numbered lines, like `cat -n`
  async read(path: string, offset?: number, limit?: number): Promise<ReadResult> {
    return json(await call(this.connection, 'GET', this.file(path), { query: { offset, limit } }))
  }

  async tree(query: TreeQuery): Promise<TreeResult> {
    return json(await call(this.connection, 'GET', `${this.base()}/tree`, { query: { ...query } }))
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    return json(await call(this.connection, 'POST', `${this.base()}/search`, { body: query }))
  }

  // all or nothing
  async edit(ops: SandboxEdit[], dryRun = false): Promise<EditedFile[]> {
    const answer = await call(this.connection, 'POST', `${this.base()}/edits`, { body: { dryRun, ops } })
    return (await json<{ files: EditedFile[] }>(answer)).files
  }

  async changes(): Promise<{ commit: string; files: ChangedFile[] }> {
    return json(await call(this.connection, 'GET', `${this.base()}/changes`))
  }

  async diff(format: 'diff' | 'patch'): Promise<string> {
    return (await call(this.connection, 'GET', `${this.base()}/changes`, { query: { format } })).text()
  }

  /**
   * Commits the changes of the sandbox and pushes them to a branch of its repository, one
   * the operator lets the caller push to. The sandbox is at the pushed commit then.
   */
  async push(branch: string, message: string): Promise<{ branch: string; commit: string }> {
    const pushed: { branch: string; commit: string } = await json(
      await call(this.connection, 'POST', `${this.base()}/push`, { body: { branch, message } })
    )
    return { branch: pushed.branch, commit: pushed.commit }
  }

  async getRun(id: string): Promise<Run> {
    return json(await call(this.connection, 'GET', `/v1/runs/${encodeURIComponent(id)}`))
  }

  // the log of a run: `task`, `tail`, `from`/`limit`, `grep` with `i` and `context`
  async logs(
    id: string,
    query: { task?: string; tail?: number; from?: number; limit?: number; grep?: string; i?: boolean; context?: number }
  ): Promise<LogPage> {
    return json(await call(this.connection, 'GET', `/v1/runs/${encodeURIComponent(id)}/logs`, { query: { ...query } }))
  }

  /**
   * Runs a task of the published build file on the sandbox and follows it to its end: the
   * lines it prints, its result and exit code. A signal cancels the run.
   */
  async runTask(task: string, options: RunTaskOptions = {}): Promise<TaskRun> {
    if (options.signal?.aborted) {
      // cancelled while it waited for its turn
      throw new SandboxClientError('the run was cancelled')
    }
    const runOptions: { [key: string]: unknown } = {}
    if (options.args) {
      runOptions.args = options.args
    }
    if (options.timeoutSeconds) {
      runOptions.timeout = `${Math.max(1, Math.ceil(options.timeoutSeconds))}s`
    }
    const submitted: Run = await json(
      await call(this.connection, 'POST', '/v1/runs', {
        body: {
          definition: { name: this.build.name },
          tasks: [task],
          source: { type: 'sandbox', id: this.id },
          options: runOptions,
        },
      })
    )
    const path = `/v1/runs/${encodeURIComponent(submitted.id)}`
    const cancel = () => {
      call(this.connection, 'POST', `${path}/cancel`).catch(() => undefined)
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    const lines: string[] = []
    let from = 1
    let truncated = false
    const readLog = async () => {
      for (;;) {
        const page: LogPage = await json(
          await call(this.connection, 'GET', `${path}/logs`, { query: { task, from, limit: 1000 } })
        )
        truncated = page.truncated
        for (const line of page.lines) {
          lines.push(line.text)
          options.onLine?.(line.text)
          from = line.line + 1
        }
        if (!page.next) {
          return
        }
      }
    }
    try {
      let run = submitted
      let waitingSaid = false
      for (;;) {
        if (options.signal?.aborted) {
          throw new SandboxClientError('the run was cancelled')
        }
        if (run.state === 'awaiting-approval' && !waitingSaid) {
          waitingSaid = true
          options.onWaiting?.(run)
        }
        await readLog()
        if (['succeeded', 'failed', 'cancelled', 'rejected'].includes(run.state)) {
          break
        }
        run = await json(await call(this.connection, 'GET', path, { query: { wait: POLL_WAIT } }))
      }
      const result = run.results?.[task]
      if (truncated && result) {
        // the end of a long log is kept in the result
        for (const line of ['… the server cut the log off at its limit, the last lines were:', ...result.lastLog]) {
          lines.push(line)
          options.onLine?.(line)
        }
      }
      return {
        run,
        result,
        output: lines.join('\n'),
        truncated,
        exitCode: exitCodeOf(result),
      }
    } finally {
      options.signal?.removeEventListener('abort', cancel)
    }
  }

  /**
   * A shell command on the sandbox: the shell task of the build file with the command as
   * its argument. `cwd` is a directory of the sandbox, `''` for its root.
   */
  async exec(command: string, cwd: string, options: Omit<RunTaskOptions, 'args'> = {}): Promise<TaskRun> {
    // on its own line: `cd dir && a; b` would run b in the root when dir is missing
    const script = cwd && cwd !== '.' ? `cd -- ${quotePosix(cwd)} || exit 1\n${command}` : command
    // a shell task in a container without `mounts: [.]` runs in an empty directory: the
    // command would see none of the files and its writes would be lost, so it does not run
    const onLine = options.onLine
    const guarded = await this.runTask(this.build.shell, {
      ...options,
      args: [`${EMPTY_GUARD}\n${script}`],
      onLine: onLine && ((line) => line !== EMPTY_MARKER && onLine(line)),
    })
    if (guarded.exitCode !== EMPTY_EXIT || !guarded.output.split('\n').includes(EMPTY_MARKER)) {
      return guarded
    }
    if ((await this.tree({ depth: 1, limit: 1 })).entries.length > 0) {
      throw new SandboxClientError(
        `the shell task ${this.build.shell} of ${this.build.name} sees none of the files of the sandbox, ` +
          `a shell task in a container needs mounts: [.] to work on them`
      )
    }
    // the sandbox is empty indeed
    return this.runTask(this.build.shell, { ...options, args: [script] })
  }

  private base(): string {
    return `/v1/sandboxes/${encodeURIComponent(this.id)}`
  }

  private file(path: string): string {
    const clean = checkSandboxPath(path)
    if (!clean) {
      throw new SandboxClientError('a file needs a path below the root of the sandbox', 400)
    }
    return `${this.base()}/files/${clean.split('/').map(encodeURIComponent).join('/')}`
  }
}

// The first lines of every shell command: it stops when the working directory is empty,
// links included, without any tool but the shell itself.
const EMPTY_MARKER = 'hammerkit: the shell sees no files'
const EMPTY_EXIT = 125
const EMPTY_GUARD = [
  'hk_seen=',
  'for hk_f in * .[!.]* ..?*; do if [ -e "$hk_f" ] || [ -L "$hk_f" ]; then hk_seen=1; break; fi; done',
  `[ -n "$hk_seen" ] || { echo '${EMPTY_MARKER}'; exit ${EMPTY_EXIT}; }`,
  'unset hk_seen hk_f',
].join('\n')

// The exit code of a task as a shell reports it: 0 for a task that succeeded or came
// from the cache, its own when it failed, none when it never ran or ended without one.
/**
 * Runs the calls one at a time, in the order they came. Agents send tool calls in parallel,
 * and the server refuses edits while a run holds the sandbox: an edit sent along with a
 * command lands before the command starts, instead of being refused.
 */
export function oneAtATime(): <T>(call: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return (call) => {
    const next = last.then(call)
    last = next.catch(() => undefined)
    return next
  }
}

export function exitCodeOf(result: TaskResult | undefined): number | null {
  if (!result) {
    return null
  }
  if (result.status === 'succeeded' || result.status === 'cached') {
    return 0
  }
  return result.exitCode ?? null
}

// A path of the sandbox as the API takes it: relative, `/` separated, no `..`.
export function checkSandboxPath(path: string): string {
  // normalize leaves no `./` but a lone `.`, and `..` only at the start
  const normal = posix.normalize(path.replace(/\\/g, '/')).replace(/\/$/, '')
  if (normal.startsWith('/') || normal === '..' || normal.startsWith('../')) {
    throw new SandboxClientError(`${path} is outside of the sandbox`, 400)
  }
  return normal === '.' ? '' : normal
}

/**
 * Maps a path of the harness onto the sandbox. Harnesses resolve paths against their own
 * working directory, which stands for the root of the sandbox: `<root>/src/a.ts` is
 * `src/a.ts` there. Anything outside of it is refused.
 */
export function toSandboxPath(root: string, path: string): string {
  const relativePath = isAbsolute(path) ? relative(root, path) : path
  if (isAbsolute(relativePath)) {
    throw new SandboxClientError(`${path} is outside of the sandbox at ${root}`, 400)
  }
  try {
    return checkSandboxPath(relativePath.split(sep).join('/'))
  } catch {
    throw new SandboxClientError(`${path} is outside of the sandbox at ${root}`, 400)
  }
}

function redact(message: string, token: string): string {
  return message.split(token).join('***')
}

export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function json<T = any>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

interface CallOptions {
  query?: { [key: string]: string | number | boolean | undefined }
  body?: unknown
  raw?: string | Uint8Array
  // a 404 is an answer, not an error
  missing?: boolean
}

async function call(
  connection: ServerConnection,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: CallOptions = {}
): Promise<Response> {
  const url = new URL(`${connection.url.replace(/\/$/, '')}${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }
  const send = async () => {
    const token = await connection.token()
    if (!isToken(token)) {
      // a header refuses such a value and would quote it whole in its error
      throw new SandboxClientError('the token is not a single line of visible characters')
    }
    return fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.raw !== undefined ? { 'content-type': 'application/octet-stream' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : options.raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // an answer from anywhere else is not the server's, and a PUT would send its file on
      redirect: 'error',
    }).catch((e) => {
      throw new SandboxClientError(
        `unable to reach ${connection.url}: ${redact(e instanceof Error ? e.message : String(e), token)}`
      )
    })
  }
  let response = await send()
  if (response.status === 401 && connection.renew) {
    await connection.renew()
    response = await send()
  }
  if (response.ok || (options.missing && response.status === 404)) {
    return response
  }
  let said = ''
  try {
    const body = await json<{ error?: unknown }>(response)
    said = typeof body?.error === 'string' ? body.error : ''
  } catch {
    // no JSON
  }
  if (response.status === 401) {
    throw new SandboxClientError(`${connection.url} did not accept the token`, 401)
  }
  throw new SandboxClientError(said || `${connection.url} answered ${response.status}`, response.status)
}
