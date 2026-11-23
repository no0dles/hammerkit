import { Command, InvalidArgumentError, Option } from 'commander'
import colors from 'colors'
import { Environment } from '../executer/environment'
import { RegisteredServer } from './host-config'
import { collectBundle } from './collect-bundle'
import { Annotations, Bundle, hashBundle, HASH_PATTERN } from './bundle'
import { applyAnnotations, CheckoutHead, collectAnnotations, readCheckout } from './annotations'
import { normalizeRepo } from '../server/repo'
import { callServer, getDiscovery, printable, printableWhole, ServerError } from './server-client'
import { showBundle } from './bundle-text'
import {
  FINAL_RUN_STATES,
  followRun,
  getMoveTarget,
  downloadRunArtifact,
  getRun,
  getRunArtifacts,
  getServerConnection,
  lookupChecks,
  readRunLog,
  RunArtifacts,
  SandboxClientError,
  ServerConnection,
  submitRun,
  SubmittedRun,
} from '../harness/sandbox-client'
import type { LogLine } from '../server/run-logs'
import { formatDuration, formatSize } from '../utils/units'
import type { Run } from '../server/runs'
import { parseEndpoint } from '../harness/service-tools'
import { showUrl } from '../harness/reconnect'
import { dirname, join, posix, resolve } from 'path'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { extractOutput } from '../utils/tar'
import { getCheckKeys } from '../optimizer/check-keys'
import type { ListedRun, Overview } from '../server/overview'
import {
  describeCapacity,
  describeOverview,
  describeServiceRun,
  describeTaskStats,
  describeWait,
} from './remote-status'
import { ranMs, roughly, TaskStats, waitedMs } from '../server/timings'
import type { Capacity } from '../server/capacity'
import { isYes } from '../utils/terminal-prompt'
import { isRelativePath } from '../utils/project-path'

export interface WorkCommandContext {
  environment: Environment
  // the build file of the working directory, or the one `--file` named
  buildFile: string
  // `how` says how the command names a server, for the message when it has to: `--server <name>`
  getServer: (name: string | undefined, how?: string) => Promise<{ name: string; server: RegisteredServer }>
  guarded: (failure: string, fn: (...args: any[]) => Promise<void>) => (...args: any[]) => Promise<void>
  // what follows `--` on the command line
  passthrough: string[]
  // ends the command with this exit code, saying why
  fail: (message: string, exitCode: number) => never
}

interface PublishedVersion {
  hash: string
  annotations?: Annotations
  created: boolean
  tasks: string[]
  services: string[]
  // set when the version is only proposed
  state?: string
  expiresAt?: string
}

// what publishing a bundle would do, as `POST /v1/definitions/plan` answers it
interface PlannedVersion {
  hash: string
  tasks: string[]
  services: string[]
  // null: the caller may not publish or propose (builds: run)
  outcome: 'published' | 'proposed' | 'already published' | null
  // the accounts it names that the caller does not use, which make it a proposal
  missing?: string[]
  yanked?: boolean
}

function describeOutcome(planned: PlannedVersion): string {
  switch (planned.outcome) {
    case 'published':
      return 'publishing it would publish it'
    case 'already published':
      return planned.yanked ? 'it is published already, and yanked' : 'it is published already'
    case 'proposed':
      return planned.missing?.length
        ? `publishing it would propose it, it names accounts you do not use: ${planned.missing
            .map(printable)
            .join(', ')}`
        : 'publishing it would propose it, somebody who may publish approves it'
    default:
      return 'the server accepts it, publishing it needs builds: propose or publish'
  }
}

// one version in the list of a server
interface VersionView {
  hash: string
  publishedAt: string
  publishedBy: { iss: string; sub: string }
  approvedBy?: { sub: string }
  annotations: Annotations
  tasks: string[]
  services: string[]
  accounts: string[]
  yanked?: { by: { sub: string }; reason?: string }
}

// a published version whole, as `GET /v1/definitions/<hash>` answers it
interface PublishedView extends Omit<VersionView, 'annotations' | 'accounts'> {
  annotations?: Annotations
  accounts?: string[]
  plan?: Record<string, PlanView>
}

interface ProposalView {
  hash: string
  annotations?: Annotations
  state: string
  proposedBy: { iss: string; sub: string }
  createdAt: string
  expiresAt: string
  decidedBy?: { sub: string }
  reason?: string
  tasks: string[]
  services: string[]
  accounts: string[]
  missing: string[]
  plan?: Record<string, PlanView>
  mine: boolean
  canDecide: boolean
}

export interface ApprovalView {
  id: string
  requestedBy: { iss: string; sub: string }
  createdAt: string
  // the hash of the published version it runs
  definition: string
  tasks: string[]
  accounts: string[]
  source: {
    type: string
    ref?: string
    snapshot?: string
    repo?: string
    commit?: string
    tree?: string
    clean?: boolean
  }
  options: Record<string, unknown>
  approvals?: { account: string; expiresAt: string; approvedBy?: { sub: string } }[]
  plan?: Record<string, PlanView>
  state: string
}

// what a task or service does, see the plan of a version on the server
export interface PlanView {
  kind: 'task' | 'service'
  runtime: string
  image?: string
  cmds: string[]
  network?: unknown
  deps: string[]
  needs: string[]
  accounts: string[]
  secrets: { from: string; account: string | null; target: string }[]
  mounts: string[]
  ports: string[]
  generates: string[]
  capAdd?: string[]
  flags: string[]
}

const RUN_ID = /^run_[A-Za-z0-9_-]{16}$/

// a task `POST /v1/checks/lookup` answers
interface LookedUpCheck {
  task: string
  key: string
  passed: {
    task: string
    status: 'succeeded' | 'cached'
    run: string
    by: { iss: string; sub: string }
    source:
      | { type: 'ref'; ref: string; commit: string }
      | { type: 'sandbox'; sandbox: string; commit: string; tree: string }
    definition: string
    finishedAt: string
    durationMs?: number
  } | null
  reason?: string
}

// how a check passed, one line
function describePassed(passed: NonNullable<LookedUpCheck['passed']>): string {
  const from =
    passed.source.type === 'ref'
      ? `${passed.source.ref} at ${passed.source.commit.slice(0, 12)}`
      : `a check of sandbox ${passed.source.sandbox}, fetched at ${passed.source.commit.slice(0, 12)}`
  return `passed ${passed.finishedAt}${
    passed.status === 'cached'
      ? ' from the cache'
      : passed.durationMs !== undefined
        ? ` in ${formatDuration(passed.durationMs)}`
        : ''
  }, ${passed.run} by ${passed.by.sub}, from ${from}`
}

// what the publisher said about where a version comes from, one line
// What a publisher said about where a version comes from: the server takes it as said,
// so anybody else is told it is not checked.
function annotationLines(annotations: Annotations | undefined, label = 'from (unverified)'): string[] {
  const entries = Object.entries(annotations ?? {})
  return entries.length > 0
    ? [`  ${label}: ${entries.map(([key, value]) => `${printable(key)}=${printable(value)}`).join(' ')}`]
    : []
}

function yankLines(version: { yanked?: { by: { sub: string }; reason?: string } }): string[] {
  return version.yanked
    ? [
        `  yanked by ${printable(version.yanked.by.sub)}${
          version.yanked.reason ? `: ${printable(version.yanked.reason)}` : ''
        }`,
      ]
    : []
}

// A line a task printed, shown as it is but for control characters, so it can't rewrite
// the terminal; tabs stay.
function printableLine(text: string): string {
  return text.split('\t').map(printableWhole).join('\t')
}

const collectOption = (value: string, previous: string[] = []) => [...previous, value]

/**
 * Why a run that did not succeed ended: its error, then each task that failed with its own
 * error or exit code, where the error of the run does not say it already.
 */
export function describeRunEnd(run: Pick<Run, 'id' | 'state' | 'error' | 'results'>): string[] {
  const lines = [`${printable(run.id)} ${printable(run.state)}${run.error ? `: ${printableWhole(run.error)}` : ''}`]
  for (const [task, result] of Object.entries(run.results ?? {})) {
    if (result.status !== 'failed') {
      continue
    }
    const why = result.error ?? (result.exitCode !== undefined ? `exit code ${result.exitCode}` : undefined)
    if (why && !run.error?.includes(`${task}: ${why}`)) {
      lines.push(`  ${printable(task)}: ${printableWhole(why)}`)
    }
  }
  return lines
}

// What `remote runs` shows of a run, on one line: how long it waited for a place and ran.
export function describeListedRun(
  run: Pick<ListedRun, 'id' | 'state' | 'createdAt' | 'tasks' | 'up' | 'error' | 'expiresAt' | 'owner' | 'queue'> &
    Partial<Pick<ListedRun, 'queuedAt' | 'startedAt' | 'finishedAt' | 'upAt'>>,
  now = Date.now()
): string {
  const what = run.up ? `up ${run.up.services.join(', ')}` : run.tasks.join(', ') || 'by labels'
  const until =
    run.up && (run.state === 'up' || run.state === 'asleep') && run.expiresAt ? ` until ${run.expiresAt}` : ''
  const queue = run.queue
    ? ` (${run.queue.position}. in the queue, waits: ${printable(describeWait(run.queue.waitsFor, !run.owner))})`
    : ''
  const waited = waitedMs(run, now)
  const ran = ranMs(run, now)
  const times = [
    waited !== undefined ? `waited ${roughly(waited)}` : '',
    ran !== undefined ? `${run.up ? 'up after' : 'ran'} ${roughly(ran)}` : '',
  ].filter(Boolean)
  return `${printable(run.id)}  ${printable(run.createdAt)}  ${printable(run.state)}${printable(
    until
  )}${queue}  ${printable(what)}${run.owner ? ` of ${printable(run.owner.sub)}` : ''}${
    times.length > 0 ? `  ${times.join(', ')}` : ''
  }${run.error ? `: ${printable(run.error)}` : ''}`
}

// What a server from before the filters of GET /v1/runs answers is filtered here, so an
// older server never shows task runs as service runs.
export function keepRuns(runs: ListedRun[], states: string[] | undefined, kind: 'tasks' | 'services' | undefined) {
  return runs.filter((run) => (!states || states.includes(run.state)) && (!kind || (kind === 'services') === !!run.up))
}

// What a person who approves is shown of a run: everything the decision rests on.
export function describeApproval(run: ApprovalView): string[] {
  const source =
    run.source.type === 'ref'
      ? `ref ${run.source.ref}`
      : run.source.type === 'sandbox'
        ? `sandbox of ${run.source.repo} at ${run.source.commit}, ${
            run.source.clean ? 'unchanged' : `with changes, files ${run.source.tree}`
          } (files .gitignore leaves out are not shown)`
        : `snapshot ${run.source.snapshot}`
  // the arguments are shown whole on a line of their own, each as a JSON string,
  // so commas, spaces and quotes inside one stay visible
  const { args, ...settings } = run.options
  const options = Object.entries(settings)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    .join(' ')
  return [
    `${colors.bold(printable(run.id))}  requested by ${printable(run.requestedBy.sub)} (${printable(
      run.requestedBy.iss
    )})`,
    `  build file ${printable(run.definition)}`,
    `  tasks: ${run.tasks.length > 0 ? run.tasks.map(printable).join(', ') : 'selected by labels'}`,
    `  accounts: ${run.accounts.length > 0 ? run.accounts.map(printable).join(', ') : 'none'}, source ${printable(
      source
    )}${options ? `, ${printable(options)}` : ''}`,
    ...(Array.isArray(args) && args.length > 0
      ? [`  arguments: ${args.map((arg) => printableWhole(JSON.stringify(arg))).join(' ')}`]
      : []),
    ...(run.approvals ?? []).map(
      (approval) =>
        `  ${printable(approval.account)}: ${
          approval.approvedBy
            ? `approved by ${printable(approval.approvedBy.sub)}`
            : 'waits for somebody who uses it to approve'
        }`
    ),
    ...flagLines(run),
    `  decide before ${printable(run.approvals?.[0]?.expiresAt ?? '-')}`,
  ]
}

// What to look at first, one line.
function flagLines(run: { plan?: Record<string, PlanView> }): string[] {
  const flagged = Object.entries(run.plan ?? {}).filter(([, entry]) => entry.flags.length > 0)
  return flagged.length > 0
    ? [
        `  look at: ${flagged
          .map(([name, entry]) => `${printable(name)} (${entry.flags.map(printable).join(', ')})`)
          .join(', ')}`,
      ]
    : []
}

// The tasks and services the run executes and what each does, never a secret's value.
export function describePlan(plan: Record<string, PlanView>): string[] {
  return Object.entries(plan).flatMap(([name, entry]) => [
    `  ${colors.bold(printable(name))}  ${entry.kind}, ${printable(entry.runtime)}${
      entry.image ? ` ${printable(entry.image)}` : ''
    }${entry.flags.length > 0 ? `  [${entry.flags.map(printable).join(', ')}]` : ''}`,
    // a command is what is decided on: shown whole, however long
    ...entry.cmds.map((cmd) => `    $ ${printableWhole(cmd)}`),
    ...(entry.network !== undefined && entry.network !== 'open'
      ? [`    network: ${printable(typeof entry.network === 'string' ? entry.network : JSON.stringify(entry.network))}`]
      : []),
    ...(entry.deps.length > 0 ? [`    after: ${entry.deps.map(printable).join(', ')}`] : []),
    ...(entry.needs.length > 0 ? [`    needs: ${entry.needs.map(printable).join(', ')}`] : []),
    ...entry.secrets.map(
      (secret) =>
        `    secret ${printable(secret.from)}${secret.account ? ` as ${printable(secret.account)}` : ''} -> ${printable(
          secret.target
        )}`
    ),
    ...(entry.mounts.length > 0 ? [`    mounts: ${entry.mounts.map(printable).join(', ')}`] : []),
    ...(entry.ports.length > 0 ? [`    ports: ${entry.ports.map(printable).join(', ')}`] : []),
    ...(entry.generates.length > 0 ? [`    generates: ${entry.generates.map(printable).join(', ')}`] : []),
    ...(entry.capAdd?.length ? [`    capAdd: ${entry.capAdd.map(printable).join(', ')}`] : []),
  ])
}

// A path in the project, as the server names an output: relative, `/` separated, no `.` or
// `..` in it. A file is written at it.
export function isProjectPath(path: string): boolean {
  return isRelativePath(path, 4096)
}

// `--path` as written: `./app/screenshots/` is `app/screenshots`
function projectPath(value: string): string {
  const path = posix
    .normalize(value.replace(/\\/g, '/'))
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
  if (!isProjectPath(path)) {
    throw new Error('--path is a path in the project, such as app/cypress/screenshots')
  }
  return path
}

type KeptOutput = RunArtifacts['outputs'][number]

// The outputs a server names that are paths in the project: one that is not is written nowhere,
// whatever the server says of it.
export function keptProjectOutputs(outputs: KeptOutput[]): KeptOutput[] {
  return outputs.filter((output) => isProjectPath(output.path))
}

/**
 * The outputs `remote artifacts` takes, each with what of it: of one task, and the output at a
 * path, the outputs below it, or the files below it of the output it is in.
 */
export function selectArtifacts(
  outputs: KeptOutput[],
  options: { task?: string; path?: string }
): { output: KeptOutput; below: string }[] {
  return outputs
    .filter((output) => options.task === undefined || output.task === options.task)
    .flatMap((output) => {
      const path = options.path
      if (path === undefined || output.path.startsWith(`${path}/`)) {
        return [{ output, below: output.path }]
      }
      return path === output.path || path.startsWith(`${output.path}/`) ? [{ output, below: path }] : []
    })
}

// Writes the chosen outputs into `out`, each at its paths in the project. Only entries of the
// output, or of the path asked for, are written, and no link out of them: the archives come
// from a server.
async function downloadArtifacts(
  connection: ServerConnection,
  id: string,
  chosen: { output: KeptOutput; below: string }[],
  out: string,
  write: (line: string) => void
): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), 'hammerkit-artifacts-'))
  try {
    await mkdir(out, { recursive: true })
    for (const { output, below } of chosen) {
      const file = join(staging, `${output.id}.tgz`)
      await downloadRunArtifact(connection, id, output.id, file)
      await extractOutput(file, out, below, true)
      write(`${printable(below)} of ${printable(output.task)} -> ${join(out, below)}`)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export function describeArtifacts(
  id: string,
  serverName: string,
  kept: Omit<RunArtifacts, 'outputs'>,
  outputs: KeptOutput[]
): string[] {
  const left = kept.left.map(
    (output) => `did not keep ${printable(output.path)} of ${printable(output.task)}: ${printable(output.reason)}`
  )
  if (outputs.length === 0) {
    return [
      `${printable(id)} on ${serverName} kept no outputs${kept.reason ? `: ${printable(kept.reason)}` : ''}`,
      ...left,
    ]
  }
  const tasks = Math.max(...outputs.map((output) => printable(output.task).length))
  const paths = Math.max(...outputs.map((output) => printable(output.path).length))
  return [
    `${printable(id)} on ${serverName} kept ${outputs.length} ${
      outputs.length === 1 ? 'output' : 'outputs'
    }, until ${printable(kept.expiresAt ?? '-')}:`,
    ...outputs.map(
      (output) =>
        `  ${printable(output.task).padEnd(tasks)}  ${printable(output.path).padEnd(paths)}  ${formatSize(
          output.bytes
        )}`
    ),
    ...left,
    `download them with: hammerkit remote artifacts ${printable(id)} --out <dir>`,
  ]
}

// The ref of a detached checkout: the one branch or tag of origin at its commit. The server
// would also fetch the commit itself, but an account limited to some branches (`refs`) never
// runs for a commit, and the run would not say where its code comes from. A branch and a tag
// of the same name are two heads, which the server can not tell apart by the name.
function onlyHead(heads: CheckoutHead[] | undefined): string | undefined {
  return heads?.length === 1 ? heads[0].name : undefined
}

// why the ref of a run is not known, and what to do
function describeMissingRef(
  repo: string,
  ours: boolean,
  checkout: { repo?: string; commit?: string; heads?: CheckoutHead[] }
): string {
  if (!checkout.commit) {
    return `name the branch or tag of ${printable(repo)} with --ref, there is no commit checked out here`
  }
  if (!ours) {
    return `name the branch or tag of ${printable(repo)} with --ref, the checkout here is on no branch and ${
      checkout.repo ? `of ${printable(checkout.repo)}` : 'has no origin it can be told by'
    }`
  }
  const heads = checkout.heads ?? []
  if (heads.length === 0) {
    return (
      `the checkout here is on no branch, and no branch or tag of origin is at its commit ${checkout.commit}: ` +
      'name the branch or tag with --ref'
    )
  }
  const names = heads.map((head) => `${head.kind} ${printable(head.name)}`)
  const twice = heads.find((head, i) => heads.findIndex((other) => other.name === head.name) !== i)
  return (
    `the checkout here is on no branch, and its commit ${checkout.commit} is the head of ` +
    `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} of origin: ` +
    (twice
      ? `${printable(twice.name)} is a branch and a tag, which --ref can not tell apart: ` +
        `name another, or the commit with --ref ${checkout.commit}`
      : 'name one with --ref')
  )
}

// A call the server refused, said as `callServer` says it: by the server and what it answered
function describeRefusal(url: string, e: unknown): unknown {
  if (!(e instanceof SandboxClientError) || e.status === undefined || e.status === 401) {
    return e
  }
  const said = e.message.startsWith(`${showUrl(url)} answered`) ? '' : `: ${printable(e.message)}`
  return new ServerError(`${showUrl(url)} answered ${e.status}${said}`, e.status)
}

export function registerWorkCommands(remote: Command, context: WorkCommandContext): void {
  const { environment, buildFile, getServer, guarded, passthrough, fail } = context

  // the ref a run starts from: what the options name, else the checkout here
  const refSource = async (options: {
    repo?: string
    ref?: string
    commit?: string
  }): Promise<{ type: 'ref'; repo: string; ref: string; commit?: string }> => {
    const checkout = options.repo && options.ref ? {} : await readCheckout(dirname(buildFile))
    const repo: string | undefined = options.repo ?? checkout.repo
    if (!repo) {
      throw new Error('name the repository with --repo, the checkout here has no origin it can be told by')
    }
    // the heads of origin name refs of the repository of the run only when origin is that one
    const ours = !!checkout.repo && normalizeRepo(repo) === checkout.repo
    const ref = options.ref ?? checkout.branch ?? (ours ? onlyHead(checkout.heads) : undefined)
    if (!ref) {
      throw new Error(describeMissingRef(repo, ours, checkout))
    }
    // the commit checked out here is the code meant, when the ref is the branch it is on, or
    // the one branch or tag of a detached checkout: when it moved since, the server refuses the run
    const commit: string | undefined = options.commit ?? (options.ref ? undefined : checkout.commit)
    return { type: 'ref', repo, ref, ...(commit ? { commit } : {}) }
  }

  // the server to call: its token is read for each call, a CI job or an agent brings its own, a
  // person signs in
  const connect = async (name: string | undefined, how?: string) => {
    const chosen = await getServer(name, how)
    return { ...chosen, connection: getServerConnection(environment, chosen.name, chosen.server) }
  }

  // publishes the bundle with where it comes from and says what it is now: published,
  // already published, or only proposed
  const publishBundle = async (
    serverName: string,
    connection: ServerConnection,
    bundle: Bundle,
    annotations: Annotations
  ): Promise<{ version: PublishedVersion; proposed: boolean }> => {
    // what is published already changes nothing and is said so: sent again, it is the same
    const answer = await callServer<PublishedVersion>(connection, 'POST', '/v1/definitions', {
      body: { ...bundle, annotations },
      repeat: 'always',
    })
    const version = answer.body
    const files = Object.keys(bundle.files).length
    // a proposal that already waits answers 200 like a published version, with its state
    const proposed = answer.status === 202 || version.state !== undefined
    const verb =
      answer.status === 202
        ? 'proposed'
        : proposed
          ? 'already proposed'
          : answer.status === 201
            ? 'published'
            : 'already published'
    environment.stdout.write(
      `${verb} to ${serverName}: ${printable(version.hash)} (${files} ${files === 1 ? 'file' : 'files'})\n`
    )
    const names = [...(version.tasks ?? []), ...(version.services ?? [])]
    environment.stdout.write(`tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
    for (const line of annotationLines(version.annotations, 'from')) {
      environment.stdout.write(`${line.trimStart()}\n`)
    }
    if (proposed) {
      environment.stdout.write(
        `it can not run before somebody who may publish approves it, until ${printable(version.expiresAt)}\n`
      )
    }
    return { version, proposed }
  }

  // what publishing the bundle would do, undefined from a server that can't say (before 2.0)
  const planBundle = async (connection: ServerConnection, bundle: Bundle): Promise<PlannedVersion | undefined> => {
    try {
      // a plan stores nothing, so it is sent again as often as the server does not answer
      return (
        await callServer<PlannedVersion>(connection, 'POST', '/v1/definitions/plan', {
          body: bundle,
          repeat: 'always',
        })
      ).body
    } catch (e) {
      if (e instanceof ServerError && e.status === 404) {
        return undefined
      }
      throw e
    }
  }

  // The build file a run or up names, and what `--publish` may publish: the hash of the
  // build file here, unless `--build` or HAMMERKIT_BUILD names a version.
  const runDefinition = async (options: {
    build?: string
    publish?: boolean
  }): Promise<{ definition: string; local?: Bundle }> => {
    const named: string | undefined = options.build ?? environment.processEnvs.HAMMERKIT_BUILD
    if (named !== undefined) {
      if (options.publish) {
        throw new Error(
          `--publish publishes the build file here, it does not go with ${
            options.build !== undefined ? '--build' : 'HAMMERKIT_BUILD'
          }`
        )
      }
      if (!HASH_PATTERN.test(named)) {
        throw new Error(`${printable(named)} is not the hash of a published version (sha256:...)`)
      }
      return { definition: named }
    }
    const local = await collectBundle(buildFile, environment, {
      // most often run in another folder than the checkout meant
      missing:
        'Run this in the checkout whose build file the server has, ' +
        'or name a published version with --build <hash>, listed by: hammerkit remote versions',
    })
    return { definition: hashBundle(local), local }
  }

  // Submits a run of a published version. When the server does not have the build file
  // here, it is published first: with --publish at once, else when the person at the
  // terminal says so. Without a terminal and without --publish the run fails and says how
  // to publish it, so CI never waits on a question.
  const submitPublishing = async (
    target: { serverName: string; connection: ServerConnection },
    request: { definition: string; [key: string]: unknown },
    local: Bundle | undefined,
    publish: boolean
  ): Promise<SubmittedRun> => {
    const { serverName, connection } = target
    try {
      return await submitRun(connection, request)
    } catch (e) {
      const status = (e as { status?: number }).status
      if (!local || status !== 400 || !/no published build file/.test(String(e))) {
        throw e
      }
    }
    const definition = request.definition
    const notPublished = `the build file here is not published on ${serverName} (${definition})`
    if (!publish) {
      if (!environment.prompt) {
        throw new Error(
          `${notPublished}, publish it first with: hammerkit remote publish ${serverName}, or pass --publish`
        )
      }
      // a server before 2.0 can't say what publishing would do: it is asked all the same,
      // and refuses then what the caller may not do
      const planned = await planBundle(connection, local)
      if (planned && planned.outcome === null) {
        throw new Error(
          `${notPublished}, and you may only run published build files (builds: run): ` +
            `somebody who may publish publishes it with: hammerkit remote publish ${serverName}`
        )
      }
      if (planned?.outcome !== 'already published') {
        const files = Object.keys(local.files).length
        environment.stdout.write(`${notPublished}, ${files} ${files === 1 ? 'file' : 'files'}\n`)
        if (planned) {
          const names = [...(planned.tasks ?? []), ...(planned.services ?? [])]
          environment.stdout.write(`tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
        }
        const proposing = planned?.outcome === 'proposed'
        if (proposing) {
          environment.stdout.write(`${describeOutcome(planned)}\n`)
        }
        const answer = await environment.prompt(
          proposing ? `propose it to ${serverName} now? [y/N] ` : `publish it to ${serverName} now and go on? [y/N] `
        )
        if (environment.abortCtrl.signal.aborted) {
          throw new Error(`stopped, nothing was published`)
        }
        if (!isYes(answer)) {
          throw new Error(`${notPublished}, nothing was published`)
        }
      }
    }
    const annotations = await collectAnnotations(buildFile, Object.keys(local.files))
    const { version, proposed } = await publishBundle(serverName, connection, local, annotations).catch((e) => {
      throw e instanceof ServerError && e.status === 403 ? new Error(`${notPublished}, ${e.message}`) : e
    })
    if (version.hash !== definition) {
      throw new Error(
        `${serverName} published ${printable(version.hash)}, not ${definition} as computed here, nothing was started`
      )
    }
    if (proposed) {
      throw new Error(
        `${definition} is only proposed on ${serverName}, nothing was started: ` +
          'run this again once somebody who may publish approves it'
      )
    }
    return submitRun(connection, request)
  }

  remote
    .command('publish [server]')
    .description('publish the build file and the files it includes to a server, runs refer to it by its hash')
    .addOption(
      new Option(
        '--annotation <key=value>',
        'say more about where it comes from, or leave one out with key=; path, repo, commit, machine and user are filled in'
      ).argParser(collectOption)
    )
    .addOption(
      new Option(
        '--dry-run',
        "check it against the server's policy and say what publishing would do, without publishing; builds: run is enough"
      )
    )
    .action(
      guarded('Remote publish was not successful', async (name: string | undefined, options) => {
        const bundle = await collectBundle(buildFile, environment)
        if (options.dryRun) {
          const { name: serverName, connection } = await connect(name)
          const answer = await callServer<PlannedVersion>(connection, 'POST', '/v1/definitions/plan', {
            body: bundle,
            repeat: 'always',
          }).catch((e) => {
            throw e instanceof ServerError && e.status === 404
              ? new Error(`${serverName} can't check a build file without publishing it, it needs hammerkit 2.0`)
              : e
          })
          const planned = answer.body
          const files = Object.keys(bundle.files).length
          environment.stdout.write(
            `checked with the policy of ${serverName}: ${printable(planned.hash)} (${files} ${
              files === 1 ? 'file' : 'files'
            }), nothing was published\n`
          )
          const names = [...(planned.tasks ?? []), ...(planned.services ?? [])]
          environment.stdout.write(`tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
          environment.stdout.write(`${describeOutcome(planned)}\n`)
          return
        }
        const annotations = applyAnnotations(
          await collectAnnotations(buildFile, Object.keys(bundle.files)),
          options.annotation ?? []
        )
        const { name: serverName, connection } = await connect(name)
        await publishBundle(serverName, connection, bundle, annotations)
      })
    )

  remote
    .command('run <tasks...>')
    .description(
      'run tasks of a published build file on a server from a git ref, print their output and exit as they did'
    )
    .addOption(
      new Option(
        '--server <name>',
        'the server to run on; when left out, the default of remote use or the only registered server'
      )
    )
    .addOption(
      new Option(
        '--build <hash>',
        'the published version to run (sha256:...), or HAMMERKIT_BUILD; the hash of the build file here when left out'
      )
    )
    .addOption(
      new Option(
        '--repo <host/path>',
        'the repository, such as github.com/corp/payments; origin of the checkout here when left out'
      )
    )
    .addOption(
      new Option(
        '--ref <ref>',
        'the branch or tag to run; the branch checked out here when left out, ' +
          'or the one branch or tag of origin at the commit of a detached checkout'
      )
    )
    .addOption(
      new Option(
        '--commit <sha>',
        'the commit the ref has to be at, else the run is refused; the commit checked out here when --ref is left out'
      )
    )
    .addOption(new Option('--env <name>', 'the environment of the build file, as --env of run'))
    .addOption(new Option('--cache <method>', 'as --cache of run').choices(['checksum', 'modify-date', 'none']))
    .addOption(new Option('--timeout <duration>', 'as --timeout of run: for tasks without their own, such as 30m'))
    .addOption(
      new Option('--max-timeout <duration>', 'as --max-timeout of run: for every task, also one with its own timeout')
    )
    .addOption(
      new Option('--detach', 'submit the run and exit, without following it: for a check that CI verifies later')
    )
    .addOption(
      new Option(
        '--publish',
        'publish the build file here first when the server does not have it, without asking; for CI and scripts'
      )
    )
    .action(
      guarded('Remote run was not successful', async (tasks: string[], options) => {
        const { definition, local } = await runDefinition(options)
        const source = await refSource(options)
        const ref = source.ref
        const { name: serverName, server } = await getServer(options.server, 'with --server <name>')
        const connection = getServerConnection(environment, serverName, server)
        const runOptions: { [key: string]: unknown } = {}
        for (const key of ['env', 'cache', 'timeout', 'maxTimeout']) {
          if (options[key] !== undefined) {
            runOptions[key] = options[key]
          }
        }
        if (passthrough.length > 0) {
          runOptions.args = passthrough
        }
        const submitted = await submitPublishing(
          { serverName, connection },
          { definition, tasks, source, options: runOptions },
          local,
          !!options.publish
        )
        const at = submitted.source.type === 'ref' ? ` at ${printable(submitted.source.commit)}` : ''
        environment.stdout.write(
          `${printable(submitted.id)} on ${serverName}: ${tasks.map(printable).join(', ')} from ${printable(
            ref
          )}${at}\n`
        )
        if (options.detach) {
          environment.stdout.write(`follow it with: hammerkit remote logs ${printable(submitted.id)} --follow\n`)
          return
        }
        const prefixed = tasks.length > 1
        const followed = await followRun(connection, submitted, {
          signal: environment.abortCtrl.signal,
          onLine: (line) => {
            environment.stdout.write(
              `${prefixed || line.task !== tasks[0] ? `[${printable(line.task)}] ` : ''}${printableLine(line.text)}\n`
            )
          },
          onWaiting: (run) => {
            for (const approval of run.approvals ?? []) {
              environment.stdout.write(
                `waiting until somebody who uses ${printable(approval.account)} approves it, before ${printable(
                  approval.expiresAt
                )}: hammerkit remote approve ${printable(run.id)}\n`
              )
            }
          },
        })
        const run = followed.run
        if (run.state === 'succeeded') {
          environment.stdout.write(`${printable(run.id)} succeeded\n`)
          return
        }
        // the exit code of the first task that failed, as `hammerkit run` would end
        const failed = tasks
          .map((task) => run.results?.[task])
          .concat(Object.values(run.results ?? {}))
          .find((result) => result?.status === 'failed')
        const exitCode = failed?.exitCode && failed.exitCode > 0 ? failed.exitCode : 1
        const [said, ...why] = describeRunEnd(run)
        for (const line of why) {
          environment.stdout.write(`${line}\n`)
        }
        environment.stdout.write(`read its log again with: hammerkit remote logs ${printable(run.id)}\n`)
        fail(said, exitCode)
      })
    )

  remote
    .command('up <services...>')
    .description(
      'start services of a published build file on a server from a git ref and keep them up until their ttl ends, ' +
        'with their endpoints at addresses of their own behind the sign-in of the server'
    )
    .addOption(
      new Option(
        '--server <name>',
        'the server to run on; when left out, the default of remote use or the only registered server'
      )
    )
    .addOption(
      new Option(
        '--endpoint <service:port>',
        'publish this port of a service, such as web:8080; may be given more than once'
      ).argParser(collectOption)
    )
    .addOption(
      new Option(
        '--ttl <duration>',
        'how long they stay once ready, such as 2h, then they are removed; the server default when left out'
      )
    )
    .addOption(
      new Option(
        '--sleep-ttl <duration>',
        'how long they stay up without a request, such as 30m, then they sleep until the next request wakes them; ' +
          'the server default when left out'
      )
    )
    .addOption(
      new Option(
        '--name <name>',
        'a later remote up of yours with the same name moves this run to its commit, or replaces it when it ' +
          'starts other services or another build file; the addresses stay; the branch when left out'
      )
    )
    .addOption(
      new Option(
        '--build <hash>',
        'the published version to run (sha256:...), or HAMMERKIT_BUILD; the hash of the build file here when left out'
      )
    )
    .addOption(new Option('--repo <host/path>', 'the repository; origin of the checkout here when left out'))
    .addOption(
      new Option(
        '--ref <ref>',
        'the branch or tag to start; the branch checked out here when left out, ' +
          'or the one branch or tag of origin at the commit of a detached checkout'
      )
    )
    .addOption(
      new Option(
        '--commit <sha>',
        'the commit the ref has to be at; the commit checked out here when --ref is left out'
      )
    )
    .addOption(new Option('--env <name>', 'the environment of the build file, as --env of run'))
    .addOption(
      new Option(
        '--publish',
        'publish the build file here first when the server does not have it, without asking; for CI and scripts'
      )
    )
    .action(
      guarded('Remote up was not successful', async (services: string[], options) => {
        const { definition, local } = await runDefinition(options)
        const endpoints = ((options.endpoint ?? []) as string[]).map(parseEndpoint)
        const source = await refSource(options)
        const { name: serverName, server } = await getServer(options.server, 'with --server <name>')
        const connection = getServerConnection(environment, serverName, server)
        const submitted = await submitPublishing(
          { serverName, connection },
          {
            definition,
            services,
            endpoints,
            ...(options.ttl ? { ttl: options.ttl } : {}),
            ...(options.sleepTtl ? { sleepTtl: options.sleepTtl } : {}),
            ...(options.name ? { name: options.name } : {}),
            source,
            options: options.env ? { env: options.env } : {},
          },
          local,
          !!options.publish
        )
        if (submitted.moved) {
          // a run of this name runs the same: it moves to the commit, with its id, addresses and volumes
          environment.stdout.write(
            `${printable(submitted.id)} on ${serverName} (${printable(submitted.state)}) moves to ${printable(
              source.ref
            )} at ${printable(
              submitted.moving?.commit ?? (submitted.source.type === 'ref' ? submitted.source.commit : '-')
            )}\n`
          )
        } else {
          environment.stdout.write(
            `${printable(submitted.id)} on ${serverName}: ${services.map(printable).join(', ')} from ${printable(
              source.ref
            )}${submitted.source.type === 'ref' ? ` at ${printable(submitted.source.commit)}` : ''}\n`
          )
        }
        const followed = await followRun(connection, submitted, {
          signal: environment.abortCtrl.signal,
          untilUp: true,
          onLine: (line) => environment.stdout.write(`[${printable(line.task)}] ${printableLine(line.text)}\n`),
          onWaiting: (run) => {
            for (const approval of run.approvals ?? []) {
              environment.stdout.write(
                `waiting until somebody who uses ${printable(approval.account)} approves it, before ${printable(
                  approval.expiresAt
                )}: hammerkit remote approve ${printable(run.id)}\n`
              )
            }
          },
        })
        const run = followed.run
        if (run.state !== 'up' && !(submitted.moved && run.state === 'asleep')) {
          const [said, ...why] = describeRunEnd(run)
          for (const line of why) {
            environment.stdout.write(`${line}\n`)
          }
          environment.stdout.write(`read its log again with: hammerkit remote logs ${printable(run.id)}\n`)
          fail(said, 1)
        }
        // the outcome of this move, not of one that came after it
        const target = getMoveTarget(submitted)
        const lastMove = [...(run.moves ?? [])].reverse().find((move) => move.commit === target)
        if (submitted.moved && lastMove?.error) {
          fail(
            `${printable(run.id)} did not move to ${printable(lastMove.commit)}: ${printable(
              lastMove.error
            )}; it stays at ${printable(run.source.type === 'ref' ? run.source.commit : '-')}`,
            1
          )
        }
        if (run.state === 'asleep') {
          // its addresses stay while it sleeps, and a request to one of them wakes it
          environment.stdout.write(
            `${printable(run.id)} sleeps, at ${printable(
              run.source.type === 'ref' ? run.source.commit : '-'
            )} when it wakes, until ${printable(run.expiresAt ?? '-')}${
              run.up?.endpoints.length ? ', a request to an endpoint wakes it' : ''
            }\n`
          )
        } else {
          environment.stdout.write(
            `${printable(run.id)} is up until ${printable(run.expiresAt ?? '-')}${
              run.up?.sleepTtl ? `, asleep after ${formatDuration(run.up.sleepTtl)} without a request` : ''
            }\n`
          )
        }
        for (const endpoint of run.up?.endpoints ?? []) {
          environment.stdout.write(`  ${printable(endpoint.service)}:${endpoint.port}  ${printable(endpoint.url)}\n`)
        }
        environment.stdout.write(
          `extend it with: hammerkit remote extend ${printable(
            run.id
          )} 8h, stop it with: hammerkit remote stop ${printable(run.id)}\n`
        )
      })
    )

  remote
    .command('status [server]')
    .description(
      'show how a server stands for you: the places that run, the queue and why each run in it waits, your limits and the runs that count against them, your service runs'
    )
    .addOption(new Option('--json', 'print the overview as the server answers it, for scripts and agents'))
    .action(
      guarded('Remote status was not successful', async (name: string | undefined, options) => {
        const { name: serverName, connection } = await connect(name)
        const overview = (await callServer<Overview>(connection, 'GET', '/v1/overview')).body
        if (options.json) {
          environment.stdout.write(`${JSON.stringify(overview, null, 2)}\n`)
          return
        }
        for (const line of describeOverview(serverName, overview)) {
          environment.stdout.write(`${line}\n`)
        }
        // a server from before /v1/capacity, or one that can not read it, prints without
        const capacity = await callServer<Capacity>(connection, 'GET', '/v1/capacity').catch(() => undefined)
        if (capacity) {
          for (const line of describeCapacity(capacity.body, true)) {
            environment.stdout.write(`${line}\n`)
          }
        }
      })
    )

  remote
    .command('capacity [server]')
    .description(
      'show what the machines of a server have and what its runs take: CPU and memory requested and in use, per namespace on Kubernetes'
    )
    .addOption(new Option('--json', 'print it as the server answers it'))
    .action(
      guarded('Remote capacity was not successful', async (name: string | undefined, options) => {
        const { connection } = await connect(name)
        const capacity = (await callServer<Capacity>(connection, 'GET', '/v1/capacity')).body
        if (options.json) {
          environment.stdout.write(`${JSON.stringify(capacity, null, 2)}\n`)
          return
        }
        for (const line of describeCapacity(capacity)) {
          environment.stdout.write(`${line}\n`)
        }
      })
    )

  remote
    .command('tasks [server]')
    .description(
      'show what the past runs of each task took, over the runs the server keeps: how often it ran, failed and came from the cache, the median and 90th percentile of its time, and how long its runs waited for a place'
    )
    .addOption(new Option('--mine', 'only your runs'))
    .addOption(
      new Option('--since <when>', 'only the runs created since then: back from now, such as 24h or 7d, or a time')
    )
    .addOption(new Option('--until <when>', 'only the runs created until then: back from now, or a time'))
    .addOption(new Option('--json', 'print it as the server answers it'))
    .action(
      guarded('Remote tasks was not successful', async (name: string | undefined, options) => {
        const { name: serverName, connection } = await connect(name)
        const query = new URLSearchParams({ scope: options.mine ? 'mine' : 'visible' })
        if (options.since) {
          query.set('since', options.since)
        }
        if (options.until) {
          query.set('until', options.until)
        }
        const { tasks } = (await callServer<{ tasks: TaskStats[] }>(connection, 'GET', `/v1/tasks?${query}`)).body
        if (options.json) {
          environment.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`)
          return
        }
        if (tasks.length === 0) {
          environment.stdout.write(
            `${serverName}: no task ran in the runs it keeps${
              options.since || options.until ? ' of that period' : ''
            }\n`
          )
          return
        }
        for (const line of describeTaskStats(tasks)) {
          environment.stdout.write(`${line}\n`)
        }
      })
    )

  remote
    .command('dashboard [server]')
    .description('print the address of the dashboard of a server, the pages of remote status, services, runs and logs')
    .action(
      guarded('Remote dashboard was not successful', async (name: string | undefined) => {
        const { name: serverName, server } = await getServer(name)
        const discovery = await getDiscovery(server, (line) => environment.stderr.write(`${line}\n`))
        if (!discovery.dashboard) {
          throw new Error(
            `${serverName} has no dashboard: it needs endpoints with a login in its config, see https://hammerkit.dev/docs/remote-compute/status#dashboard`
          )
        }
        environment.stdout.write(`${printable(discovery.dashboard)}\n`)
      })
    )

  remote
    .command('services [server]')
    .description(
      'list the service runs that are starting, up or asleep: yours, and those whose endpoints you may open, with their addresses and when they end or sleep'
    )
    .addOption(new Option('--ended', 'also the ones that ended, as long as the server keeps them'))
    .action(
      guarded('Remote services was not successful', async (name: string | undefined, options) => {
        const { name: serverName, connection } = await connect(name)
        const open = ['awaiting-approval', 'queued', 'running', 'up', 'asleep']
        const states = options.ended ? '' : `&state=${open.join(',')}`
        const runs = keepRuns(
          (await callServer<{ runs: ListedRun[] }>(connection, 'GET', `/v1/runs?scope=visible&kind=services${states}`))
            .body.runs,
          options.ended ? undefined : open,
          'services'
        )
        if (runs.length === 0) {
          environment.stdout.write(
            `${serverName}: no service runs${options.ended ? '' : ' are starting, up or asleep'}\n`
          )
          return
        }
        for (const run of runs) {
          for (const line of describeServiceRun(run)) {
            environment.stdout.write(`${line}\n`)
          }
        }
      })
    )

  remote
    .command('runs [server]')
    .description('list your runs on a server, newest first: their state, where a queued one stands, and why one failed')
    .addOption(new Option('--limit <count>', 'show at most this many').default('20'))
    .addOption(
      new Option(
        '--state <states>',
        'only runs in these states, comma separated: awaiting-approval, queued, running, up, asleep, succeeded, failed, cancelled, rejected'
      )
    )
    .addOption(new Option('--services', 'only service runs').conflicts('tasks'))
    .addOption(new Option('--tasks', 'only runs of tasks'))
    .addOption(
      new Option(
        '--all',
        'also the runs of others you may see: those you may approve, service runs you may open, every run with observe'
      )
    )
    .action(
      guarded('Remote runs was not successful', async (name: string | undefined, options) => {
        const limit = Number(options.limit)
        if (!Number.isInteger(limit) || limit < 1) {
          throw new Error('--limit is a number of runs, 1 or more')
        }
        const query = new URLSearchParams()
        if (options.all) {
          query.set('scope', 'visible')
        }
        if (options.state) {
          query.set('state', options.state)
        }
        if (options.services || options.tasks) {
          query.set('kind', options.services ? 'services' : 'tasks')
        }
        const { name: serverName, connection } = await connect(name)
        const path = `/v1/runs${query.toString() ? `?${query}` : ''}`
        const runs = keepRuns(
          (await callServer<{ runs: ListedRun[] }>(connection, 'GET', path)).body.runs,
          options.state ? String(options.state).split(',') : undefined,
          options.services ? 'services' : options.tasks ? 'tasks' : undefined
        )
        if (runs.length === 0) {
          environment.stdout.write(
            `${serverName}: ${
              query.toString() ? 'no runs it keeps are like that' : 'you have no runs it still keeps'
            }\n`
          )
          return
        }
        for (const run of runs.slice(0, limit)) {
          environment.stdout.write(`${describeListedRun(run)}\n`)
        }
        if (runs.length > limit) {
          environment.stdout.write(`… and ${runs.length - limit} older, see them with --limit ${runs.length}\n`)
        }
      })
    )

  remote
    .command('logs <run> [server]')
    .description(
      'print the log of a run, also of one that ended: what its tasks and services printed, and what the server and the cluster said'
    )
    .addOption(new Option('--task <name>', 'only the lines of this task or service'))
    .addOption(
      new Option('--tail <lines>', 'only the last lines, at most 1000').argParser((value) => {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000) {
          throw new InvalidArgumentError('a number of lines from 1 to 1000')
        }
        return Number(value)
      })
    )
    .addOption(
      new Option('-f, --follow', 'keep printing what comes until the run ends; ctrl-c stops following, not the run')
    )
    .action(
      guarded('Remote logs was not successful', async (id: string, name: string | undefined, options) => {
        if (!RUN_ID.test(id)) {
          throw new Error(`${printable(id)} is not a run id (run_...), list them with: hammerkit remote runs`)
        }
        if (options.follow && options.tail !== undefined) {
          throw new Error('--follow prints the whole log, leave --tail out')
        }
        const { name: serverName, server } = await getServer(name)
        const connection = getServerConnection(environment, serverName, server)
        const found = await getRun(connection, id)
        if (!found) {
          throw new Error(
            `${serverName} keeps no run ${printable(id)} you may see, list them with: hammerkit remote runs`
          )
        }
        let run = found
        const task: string | undefined = options.task
        const print = (line: LogLine) =>
          environment.stdout.write(`${task ? '' : `[${printable(line.task)}] `}${printableLine(line.text)}\n`)
        if (options.follow) {
          run = (
            await followRun(connection, run, {
              task,
              signal: environment.abortCtrl.signal,
              detach: true,
              onLine: print,
            })
          ).run
        } else {
          await readRunLog(connection, run, { task, tail: options.tail }, print)
        }
        if (run.state === 'succeeded' || run.state === 'up' || run.state === 'asleep') {
          environment.stdout.write(`${printable(run.id)} ${printable(run.state)}\n`)
        } else if (FINAL_RUN_STATES.includes(run.state)) {
          for (const line of describeRunEnd(run)) {
            environment.stdout.write(`${line}\n`)
          }
        } else {
          environment.stdout.write(`${printable(run.id)} is ${printable(run.state)}, follow it with --follow\n`)
        }
      })
    )

  remote
    .command('artifacts <run> [server]')
    .description(
      'list or download the outputs the tasks of a run that ended export (generates with export: true, ' +
        'or export: always also of a task that failed); none of a run in which anything reads a secret'
    )
    .addOption(new Option('--task <name>', 'only the outputs of this task'))
    .addOption(new Option('--path <path>', 'only the output at this path in the project, or the files of one below it'))
    .addOption(
      new Option(
        '--out <dir>',
        'download them into this directory, at their paths in the project; else they are listed'
      )
    )
    .action(
      guarded('Remote artifacts was not successful', async (id: string, name: string | undefined, options) => {
        if (!RUN_ID.test(id)) {
          throw new Error(`${printable(id)} is not a run id (run_...), list them with: hammerkit remote runs`)
        }
        const path = options.path === undefined ? undefined : projectPath(options.path)
        const { name: serverName, server } = await getServer(name)
        const connection = getServerConnection(environment, serverName, server)
        const kept = await getRunArtifacts(connection, id)
        if (!kept) {
          throw new Error(
            `${serverName} keeps no run ${printable(id)} you may see, list them with: hammerkit remote runs`
          )
        }
        const outputs = keptProjectOutputs(kept.outputs)
        const chosen = selectArtifacts(outputs, { task: options.task, path })
        const selecting = options.task !== undefined || path !== undefined
        if (chosen.length === 0 && selecting) {
          const all = outputs.map((output) => printable(output.path)).join(' and ') || 'nothing'
          throw new Error(
            `the run kept nothing ${
              path !== undefined ? `at or below ${printable(path)}` : `of ${printable(options.task)}`
            }, it kept ${all}`
          )
        }
        // nothing to download (or no --out): the listing, before anything is made
        if (options.out === undefined || chosen.length === 0) {
          const shown = selecting ? chosen.map(({ output }) => output) : outputs
          for (const line of describeArtifacts(id, serverName, kept, shown)) {
            environment.stdout.write(`${line}\n`)
          }
          return
        }
        await downloadArtifacts(connection, id, chosen, resolve(environment.cwd, options.out), (line) =>
          environment.stdout.write(`${line}\n`)
        )
      })
    )

  remote
    .command('extend <run> <ttl> [server]')
    .description('keep a service run that is up for this long from now, such as 8h, at most the maxTtl of the server')
    .action(
      guarded('Remote extend was not successful', async (id: string, ttl: string, name: string | undefined) => {
        if (!RUN_ID.test(id)) {
          throw new Error(`${printable(id)} is not a run id (run_...)`)
        }
        const { name: serverName, connection } = await connect(name)
        // the end is set to this long from now, so sent again it is the same
        const run = (
          await callServer<Run>(connection, 'POST', `/v1/runs/${id}/extend`, { body: { ttl }, repeat: 'always' })
        ).body
        environment.stdout.write(
          `${printable(run.id)} on ${serverName} stays up until ${printable(run.expiresAt ?? '-')}\n`
        )
      })
    )

  remote
    .command('stop <run> [server]')
    .description('stop a run: a service run takes its services and endpoints down')
    .action(
      guarded('Remote stop was not successful', async (id: string, name: string | undefined) => {
        if (!RUN_ID.test(id)) {
          throw new Error(`${printable(id)} is not a run id (run_...)`)
        }
        const { name: serverName, connection } = await connect(name)
        // a run that is over stays so: sent again, the stop answers the same
        const run = (await callServer<Run>(connection, 'POST', `/v1/runs/${id}/cancel`, { repeat: 'always' })).body
        environment.stdout.write(
          `${printable(run.id)} on ${serverName}: ${
            run.state === 'up' || run.state === 'running' ? 'stopping' : printable(run.state)
          }\n`
        )
      })
    )

  remote
    .command('retry <run> [server]')
    .description(
      'start a run that is over again, as a new run of yours: the same tasks or services, settings and commit'
    )
    .action(
      guarded('Remote retry was not successful', async (id: string, name: string | undefined) => {
        if (!RUN_ID.test(id)) {
          throw new Error(`${printable(id)} is not a run id (run_...)`)
        }
        const { name: serverName, connection } = await connect(name)
        // each retry starts a run of its own: sent again only when the server did not take it
        const run = (await callServer<Run>(connection, 'POST', `/v1/runs/${id}/retry`, { repeat: 'unsent' })).body
        environment.stdout.write(
          `${printable(run.id)} on ${serverName} retries ${printable(id)}: ${printable(run.state)}, ` +
            `follow it with hammerkit remote logs ${printable(run.id)} --follow\n`
        )
      })
    )

  remote
    .command('verify <tasks...>')
    .description(
      'check that the server already passed tasks for the files checked out here, without running them; ' +
        'exits 1 at once for any it did not'
    )
    .addOption(
      new Option(
        '--server <name>',
        'the server to ask; when left out, the default of remote use or the only registered server'
      )
    )
    .addOption(
      new Option(
        '--repo <host/path>',
        'the repository, such as github.com/corp/payments; origin of the checkout here when left out'
      )
    )
    .addOption(new Option('--env <name>', 'the environment of the build file, as --env of run'))
    .action(
      guarded('Remote verify was not successful', async (tasks: string[], options) => {
        const repo: string | undefined = options.repo ?? (await readCheckout(dirname(buildFile))).repo
        if (!repo) {
          throw new Error('name the repository with --repo, the checkout here has no origin it can be told by')
        }
        const keys: { task: string; key: string }[] = []
        const unkeyed: { task: string; reason: string }[] = []
        for (const task of tasks) {
          const found = (
            await getCheckKeys(buildFile, environment, { taskName: task, environmentName: options.env ?? null })
          )[task]
          if (!found) {
            throw new Error(`the build file has no task ${printable(task)}`)
          }
          if (found.key === null) {
            unkeyed.push({ task, reason: found.reason })
          } else {
            keys.push({ task, key: found.key })
          }
        }
        const { name: serverName, server } = await getServer(options.server, 'with --server <name>')
        const answer =
          keys.length > 0
            ? await lookupChecks<LookedUpCheck>(getServerConnection(environment, serverName, server), repo, keys).catch(
                (e) => {
                  throw describeRefusal(server.url, e)
                }
              )
            : { checks: [] as LookedUpCheck[] }
        const missing: string[] = []
        // by what was asked, never by what was answered: a task the answer leaves out, or
        // answers for another key, is not verified
        for (const { task, key } of keys) {
          const check = answer.checks.find((answered) => answered.task === task && answered.key === key)
          if (check?.passed) {
            environment.stdout.write(`${printable(task)}: ${printable(describePassed(check.passed))}\n`)
          } else {
            missing.push(task)
            environment.stdout.write(
              `${printable(task)}: no run on ${serverName} passed it for these files${
                check?.reason ? `, ${printable(check.reason)}` : ''
              }\n`
            )
          }
        }
        for (const { task, reason } of unkeyed) {
          environment.stdout.write(`${printable(task)}: can not be verified, ${printable(reason)}\n`)
        }
        if (missing.length > 0 || unkeyed.length > 0) {
          const run =
            missing.length > 0 ? `; run on the server: hammerkit remote run ${missing.map(printable).join(' ')}` : ''
          // whole names: a task of an include is named like build:all
          const names = [...missing, ...unkeyed.map(({ task }) => task)].map(printable)
          fail(`not verified: ${names.join(', ')}${run}`, 1)
        }
      })
    )

  remote
    .command('versions [server]')
    .description('list the published versions of build files on a server, newest first, with where they come from')
    .addOption(
      new Option(
        '--filter <key=value>',
        'only the versions with this annotation, such as repo=github.com/corp/payments'
      ).argParser(collectOption)
    )
    .action(
      guarded('Remote versions was not successful', async (name: string | undefined, options) => {
        const query = new URLSearchParams()
        for (const filter of (options.filter ?? []) as string[]) {
          const index = filter.indexOf('=')
          if (index <= 0) {
            throw new Error(`${printable(filter)} is not a filter, write it as key=value`)
          }
          if (index === filter.length - 1) {
            throw new Error(`${printable(filter)} matches nothing, an annotation always has a value`)
          }
          query.append(filter.slice(0, index), filter.slice(index + 1))
        }
        const { name: serverName, connection } = await connect(name)
        const path = `/v1/definitions${query.toString() !== '' ? `?${query}` : ''}`
        const { body } = await callServer<{ definitions: VersionView[] }>(connection, 'GET', path)
        if (body.definitions.length === 0) {
          environment.stdout.write(`${serverName}: no published versions${query.toString() !== '' ? ' match' : ''}\n`)
          return
        }
        environment.stdout.write(`${serverName}: ${body.definitions.length} published\n`)
        for (const version of body.definitions) {
          environment.stdout.write(
            `${colors.bold(printable(version.hash))}  published by ${printable(version.publishedBy.sub)} at ${printable(
              version.publishedAt
            )}${version.approvedBy ? `, approved by ${printable(version.approvedBy.sub)}` : ''}\n`
          )
          for (const line of annotationLines(version.annotations)) {
            environment.stdout.write(`${line}\n`)
          }
          const names = [...version.tasks, ...version.services]
          environment.stdout.write(`  tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
          if (version.accounts.length > 0) {
            environment.stdout.write(`  accounts: ${version.accounts.map(printable).join(', ')}\n`)
          }
          for (const line of yankLines(version)) {
            environment.stdout.write(`${line}\n`)
          }
        }
      })
    )

  remote
    .command('approvals [server]')
    .description('list the runs on a server that wait for your approval')
    .action(
      guarded('Remote approvals was not successful', async (name: string | undefined) => {
        const { name: serverName, connection } = await connect(name)
        const { body } = await callServer<{ approvals: ApprovalView[] }>(connection, 'GET', '/v1/approvals')
        if (body.approvals.length === 0) {
          environment.stdout.write(`${serverName}: no runs wait for your approval\n`)
          return
        }
        environment.stdout.write(`${serverName}: ${body.approvals.length} waiting for your approval\n`)
        for (const run of body.approvals) {
          for (const line of describeApproval(run)) {
            environment.stdout.write(`${line}\n`)
          }
        }
      })
    )

  // A version that is published: who published it, what its tasks do and every file.
  const showPublished = async (hash: string, serverName: string, connection: ServerConnection) => {
    const path = `/v1/definitions/${hash}`
    let version: PublishedView
    try {
      version = (await callServer<PublishedView>(connection, 'GET', path)).body
    } catch (e) {
      if (e instanceof ServerError && e.status === 404) {
        throw new Error(`${serverName} has no proposal or published version ${printable(hash)} you may see`)
      }
      throw e
    }
    const files = (await callServer<Bundle>(connection, 'GET', `${path}/files`)).body
    environment.stdout.write(
      `${colors.bold(printable(version.hash))} on ${serverName}, published by ${printable(
        version.publishedBy.sub
      )} (${printable(version.publishedBy.iss)}) at ${printable(version.publishedAt)}${
        version.approvedBy ? `, approved by ${printable(version.approvedBy.sub)}` : ''
      }\n`
    )
    for (const line of [
      ...yankLines(version),
      ...annotationLines(version.annotations),
      ...flagLines(version),
      ...(version.plan ? describePlan(version.plan) : ['  the server did not record what its tasks do']),
      ...showBundle(files),
    ]) {
      environment.stdout.write(`${line}\n`)
    }
  }

  remote
    .command('show <target> [server]')
    .description(
      'show a run (run_...) or a proposed or published version (sha256:...) in full: the commands, secrets and accounts of its tasks, and the files of a version'
    )
    .action(
      guarded('Remote show was not successful', async (target: string, name: string | undefined) => {
        if (!RUN_ID.test(target) && !HASH_PATTERN.test(target)) {
          throw new Error(
            `${printable(
              target
            )} is not a run id or a version, list them with: hammerkit remote approvals, remote proposals or remote versions`
          )
        }
        const { name: serverName, connection } = await connect(name)
        if (HASH_PATTERN.test(target)) {
          const path = `/v1/proposals/${target}`
          let proposal: ProposalView
          try {
            proposal = (await callServer<ProposalView>(connection, 'GET', path)).body
          } catch (e) {
            if (e instanceof ServerError && e.status === 404) {
              await showPublished(target, serverName, connection)
              return
            }
            throw e
          }
          if (proposal.state === 'approved') {
            await showPublished(target, serverName, connection)
            return
          }
          if (proposal.state !== 'waiting') {
            // a decided proposal keeps no files
            environment.stdout.write(
              `${colors.bold(printable(proposal.hash))} on ${serverName}, proposed by ${printable(
                proposal.proposedBy.sub
              )}, ${printable(proposal.state)}${proposal.decidedBy ? ` by ${printable(proposal.decidedBy.sub)}` : ''}${
                proposal.reason ? `: ${printable(proposal.reason)}` : ''
              }\n`
            )
            for (const line of annotationLines(proposal.annotations)) {
              environment.stdout.write(`${line}\n`)
            }
            environment.stdout.write('  its files are not kept once it is decided\n')
            return
          }
          const files = (await callServer<Bundle>(connection, 'GET', `${path}/files`)).body
          environment.stdout.write(
            `${colors.bold(printable(proposal.hash))} on ${serverName}, proposed by ${printable(
              proposal.proposedBy.sub
            )} (${printable(proposal.proposedBy.iss)}), ${printable(proposal.state)}\n`
          )
          for (const line of [
            ...annotationLines(proposal.annotations),
            ...flagLines(proposal),
            ...describePlan(proposal.plan ?? {}),
            ...showBundle(files),
          ]) {
            environment.stdout.write(`${line}\n`)
          }
          return
        }
        const view = (await callServer<ApprovalView>(connection, 'GET', `/v1/approvals/${target}`)).body
        for (const line of describeApproval(view)) {
          environment.stdout.write(`${line}\n`)
        }
        environment.stdout.write(
          view.plan ? `${describePlan(view.plan).join('\n')}\n` : 'the server did not record what its tasks do\n'
        )
      })
    )

  remote
    .command('proposals [server]')
    .description('list the proposed versions of build files you made or may approve')
    .action(
      guarded('Remote proposals was not successful', async (name: string | undefined) => {
        const { name: serverName, connection } = await connect(name)
        const { body } = await callServer<{ proposals: ProposalView[] }>(connection, 'GET', '/v1/proposals')
        if (body.proposals.length === 0) {
          environment.stdout.write(`${serverName}: no proposed versions\n`)
          return
        }
        environment.stdout.write(`${serverName}: ${body.proposals.length} proposed\n`)
        for (const proposal of body.proposals) {
          const who = proposal.mine ? 'you' : printable(proposal.proposedBy.sub)
          const state = proposal.canDecide ? colors.bold('waits for your approval') : printable(proposal.state)
          environment.stdout.write(`${colors.bold(printable(proposal.hash))}  proposed by ${who}, ${state}\n`)
          for (const line of annotationLines(proposal.annotations)) {
            environment.stdout.write(`${line}\n`)
          }
          const names = [...proposal.tasks, ...proposal.services]
          environment.stdout.write(`  tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
          if (proposal.accounts.length > 0) {
            environment.stdout.write(
              `  accounts: ${proposal.accounts.map(printable).join(', ')}${
                proposal.missing.length > 0
                  ? `, the proposer does not use ${proposal.missing.map(printable).join(', ')}`
                  : ''
              }\n`
            )
          }
          for (const line of flagLines(proposal)) {
            environment.stdout.write(`${line}\n`)
          }
          if (proposal.state === 'waiting') {
            environment.stdout.write(`  decide before ${printable(proposal.expiresAt)}\n`)
          } else if (proposal.reason) {
            environment.stdout.write(`  ${printable(proposal.state)}: ${printable(proposal.reason)}\n`)
          }
        }
      })
    )

  for (const action of ['yank', 'unyank'] as const) {
    remote
      .command(`${action} <version> [server]`)
      .description(
        action === 'yank'
          ? 'pull a published version (sha256:...) back: no run starts from it'
          : 'let a yanked version (sha256:...) go on'
      )
      .addOption(new Option('--reason <text>', 'why, shown to whoever tries to run it').argParser((value) => value))
      .action(
        guarded(`Remote ${action} was not successful`, async (target: string, name: string | undefined, options) => {
          if (!HASH_PATTERN.test(target)) {
            throw new Error(`${printable(target)} is not a version, name it by its hash: sha256:...`)
          }
          const { name: serverName, connection } = await connect(name)
          // a version already yanked, or let go on, stays so: sent again, the answer is the same
          await callServer(connection, 'POST', `/v1/definitions/${target}/${action}`, {
            body: options.reason ? { reason: options.reason } : undefined,
            repeat: 'always',
          })
          environment.stdout.write(
            `${action === 'yank' ? 'yanked' : 'let go on'} ${printable(target)} on ${serverName}\n`
          )
        })
      )
  }

  for (const action of ['approve', 'reject'] as const) {
    remote
      .command(`${action} <target> [server]`)
      .description(
        action === 'approve'
          ? 'let a run (run_...) or a proposed version (sha256:...) that waits for your approval go ahead'
          : 'end a run (run_...) or drop a proposed version (sha256:...) that waits for your approval'
      )
      .addOption(new Option('--reason <text>', 'why, shown to who asked').argParser((value) => value))
      .action(
        guarded(`Remote ${action} was not successful`, async (target: string, name: string | undefined, options) => {
          const proposal = HASH_PATTERN.test(target)
          if (!proposal && !RUN_ID.test(target)) {
            throw new Error(
              `${printable(
                target
              )} is not a run id or a proposed version, list them with: hammerkit remote approvals or remote proposals`
            )
          }
          const { name: serverName, connection } = await connect(name)
          const path = proposal ? `/v1/proposals/${target}/${action}` : `/v1/approvals/${target}/${action}`
          // a decision taken twice is refused the second time (409): sent again only when the
          // server did not take it
          const { body } = await callServer<{ state: string }>(connection, 'POST', path, {
            body: options.reason ? { reason: options.reason } : undefined,
            repeat: 'unsent',
          })
          const rejected = body.state === 'rejected'
          environment.stdout.write(
            proposal
              ? rejected
                ? `rejected ${target} on ${serverName}\n`
                : `approved ${target} on ${serverName}, it is published\n`
              : rejected
                ? `rejected ${target} on ${serverName}\n`
                : `approved ${target} on ${serverName}, it is queued\n`
          )
        })
      )
  }
}
