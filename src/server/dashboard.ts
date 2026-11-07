import { IncomingMessage, ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import { HASH_PATTERN } from '../remote/bundle'
import type { Capacity, CapacityGroup, CapacityReader, Resources } from './capacity'
import { formatCpu, formatMemory } from './capacity-format'
import { bar, cut, h, HEADERS, Nav, printableLine, sendPage, span } from './dashboard-html'
import { DefinitionError, DefinitionStore } from './definitions'
import { Principal, quote } from './oauth'
import {
  decides,
  describeWait,
  filterRuns,
  getOverview,
  ListedRun,
  Meter,
  mayRead,
  maySee,
  Overview,
  owns,
  queuePlace,
  toListedRun,
  Viewer,
  visibleCapacity,
} from './overview'
import type { TaskPlan } from './plan'
import { canUse, getGrant, mayPublish } from './policy'
import { decideProposal, mayApprove } from './proposals-api'
import type { Proposal, ProposalRegistry } from './proposals'
import { readLogs, LogLine, MAX_LOG_LINES } from './run-logs'
import { isFinal, Run, RunRegistry, RunState } from './runs'
import type { ServerConfig } from './server-config'
import { mayOpenEndpoints } from './service-runs'
import { getTaskStats, ranMs, roughly, TaskStats, waitedMs } from './timings'
import { formatDuration, parseDuration } from '../utils/units'

/**
 * The dashboard: pages of the server's own that show a person what `remote status`,
 * `remote services`, `remote runs`, `remote tasks`, `remote logs` and `remote approvals`
 * print, with the same rules of who sees what (overview.ts), and the buttons to stop and
 * extend runs and to decide about approvals. The pages are plain HTML, without a script: a
 * page that changes reloads itself with a `refresh` header. Text of runs (task names, log
 * lines, errors, files) comes from whoever wrote the build file and is always escaped.
 */
export interface DashboardContext {
  config: ServerConfig
  registry: RunRegistry
  // signs the token of the forms, with the key of the sessions
  sign: (value: string) => string
  log: (line: string) => void
  now?: () => number
  // the build file versions that wait for somebody who may publish
  proposals?: ProposalRegistry
  definitions?: DefinitionStore
  // what the machines have and the runs use
  capacity?: CapacityReader
  // what the token of the forms is bound to: the sign-in (its session), or an API token
  session?: string
  // when the person signed in to the dashboard; left out for a caller with an API token
  signedInAt?: number
}

const REFRESH_SECONDS = 10
// Approving and publishing take a sign-in of the last minutes: the groups of a session are
// those of its sign-in, and somebody taken out of a group must not decide for hours.
export const DECIDE_WITHIN_MS = 15 * 60_000
const LOG_LINES = 200
const EXTEND_CHOICES = ['1h', '8h', '24h', '72h']
const ACTIVE: RunState[] = ['awaiting-approval', 'queued', 'running', 'up', 'asleep']
const STATES: RunState[] = [
  'awaiting-approval',
  'queued',
  'running',
  'up',
  'asleep',
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
]
const DAY = 24 * 60 * 60 * 1000
const RUN_ID = 'run_[A-Za-z0-9_-]{16}'

export async function handleDashboard(
  context: DashboardContext,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const now = context.now ?? Date.now
  const grant = getGrant(context.config.entitlements, principal)
  const viewer: Viewer = { principal, grant, activity: context.config.runs.activity === 'everyone' }
  const page = new Page(context, viewer, now())
  if (grant.matched.length === 0) {
    return page.send(res, 403, 'Not allowed', '<p>You are not entitled to anything on this server.</p>')
  }
  const path = url.pathname
  if (req.method === 'POST') {
    return post(context, page, viewer, req, res, path)
  }
  if (
    (req.method !== 'GET' && req.method !== 'HEAD') ||
    new RegExp(`^/(runs/${RUN_ID}/(stop|extend)|approvals/(runs|versions)/[^/]+/(approve|reject))$`).test(path)
  ) {
    return page.send(res, 405, 'Not allowed', '<p>This is done with the buttons of the pages.</p>')
  }
  if (path === '/') {
    const overview = getOverview(context.registry.snapshot(), context.registry.usage(principal), viewer)
    const capacity = await page.readCapacity()
    return page.send(res, 200, 'Overview', page.overview(overview, capacity), { refresh: true, nav: 'overview' })
  }
  if (path === '/services') {
    const runs = filterRuns(context.registry.all(), viewer, { scope: 'visible', kind: 'services' })
    return page.send(res, 200, 'Service runs', page.services(runs), { refresh: true, nav: 'services' })
  }
  if (path === '/runs') {
    return page.send(res, 200, 'Runs', page.runs(url.searchParams), { nav: 'runs' })
  }
  if (path === '/tasks') {
    return page.send(res, 200, 'Tasks', page.tasks(url.searchParams), { nav: 'tasks' })
  }
  if (path === '/approvals') {
    // no reload: it would wipe the reason of a reject being typed
    return page.send(res, 200, 'Approvals', page.approvals(), { nav: 'approvals' })
  }
  if (path === '/capacity') {
    const capacity = await page.readCapacity()
    return page.send(res, 200, 'Capacity', page.capacity(capacity), { refresh: true, nav: 'capacity' })
  }
  const version = /^\/approvals\/versions\/([^/]+)$/.exec(path)
  if (version) {
    const proposal = HASH_PATTERN.test(version[1]) ? context.proposals?.get(version[1]) : undefined
    if (!proposal || !page.maySeeProposal(proposal)) {
      return page.send(res, 404, 'Not found', '<p>There is no such version you may see.</p>', { nav: 'approvals' })
    }
    return page.send(res, 200, 'Build file version', page.version(proposal), { nav: 'approvals' })
  }
  const one = new RegExp(`^/runs/(${RUN_ID})(/log|/log\\.txt)?$`).exec(path)
  if (one) {
    const run = context.registry.peek(one[1])
    if (!run || !maySee(viewer, run)) {
      return page.send(res, 404, 'Not found', '<p>There is no such run you may see.</p>', { nav: 'runs' })
    }
    if (one[2]) {
      if (!mayRead(viewer, run)) {
        return page.send(
          res,
          404,
          'Not found',
          '<p>The log of this run is for its owner and who decides about it.</p>',
          {
            nav: 'runs',
          }
        )
      }
      if (one[2] === '/log.txt') {
        return page.logText(res, run, url.searchParams)
      }
      return page.send(res, 200, `Log of ${run.id}`, page.log(run, url.searchParams), { nav: 'runs' })
    }
    return page.send(res, 200, run.id, page.run(run, url.searchParams), {
      refresh: !isFinal(run.state) && !page.mayDecideRun(run),
      nav: 'runs',
    })
  }
  return page.send(res, 404, 'Not found', '<p>There is no such page.</p>')
}

// What the forms of the pages send: stop and extend a run, decide about a run or a version.
async function post(
  context: DashboardContext,
  page: Page,
  viewer: Viewer,
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<void> {
  const { principal, grant } = viewer
  const runAction = new RegExp(`^/runs/(${RUN_ID})/(stop|extend)$`).exec(path)
  const runDecision = new RegExp(`^/approvals/runs/(${RUN_ID})/(approve|reject)$`).exec(path)
  const versionDecision = /^\/approvals\/versions\/([^/]+)\/(approve|reject)$/.exec(path)
  if (!runAction && !runDecision && !versionDecision) {
    return page.send(res, 405, 'Not allowed', '<p>Use the buttons of the pages.</p>')
  }
  const form = new URLSearchParams(await readText(req, 4096))
  if (!page.validCsrf(form.get('csrf'))) {
    return page.send(res, 403, 'Not allowed', '<p>The form is out of date, open the page again.</p>')
  }
  const reason = (form.get('reason') ?? '').trim().slice(0, 500) || undefined
  const done = (back: string) => {
    res.writeHead(303, { location: back, 'cache-control': 'no-store' })
    res.end()
  }
  if (runAction) {
    const [, id, verb] = runAction
    const back = ownBack(form.get('back'), `/runs/${id}`)
    if (verb === 'stop') {
      const run = context.registry.cancel(principal, id, (account) => canUse(grant, account))
      context.log(`dashboard stop iss=${principal.iss} sub=${principal.sub} run=${id} found=${Boolean(run)}`)
      if (!run) {
        return page.send(res, 404, 'Not found', '<p>There is no such run you may stop.</p>')
      }
      return done(back)
    }
    let ttl: number
    try {
      ttl = parseDuration(form.get('ttl') ?? '')
      if (!(ttl > 0)) {
        throw new Error('no time')
      }
    } catch {
      return page.send(res, 400, 'Not a duration', '<p>Pick how long it should stay.</p>')
    }
    const result = context.registry.extend(principal, id, ttl, (run) => mayOpenEndpoints(grant, run))
    context.log(`dashboard extend iss=${principal.iss} sub=${principal.sub} run=${id} result=${result.status}`)
    if (result.status === 'not-found') {
      return page.send(res, 404, 'Not found', '<p>There is no such run you may extend.</p>')
    }
    if (result.status === 'not-up') {
      return page.send(
        res,
        409,
        'Not up',
        `<p>The run is ${h(result.state)}, only a service run that is up can be extended.</p>`
      )
    }
    return done(back)
  }
  if ((runDecision || versionDecision) && !page.signedInLately()) {
    return page.send(
      res,
      403,
      'Sign in again',
      `<p>Approving and rejecting take a sign-in of the last ${
        DECIDE_WITHIN_MS / 60_000
      } minutes.</p><p>${page.signInAgain(ownBack(form.get('back'), '/approvals'))}</p>`
    )
  }
  if (runDecision) {
    const [, id, verb] = runDecision
    const outcome = verb === 'approve' ? 'approved' : 'rejected'
    const result = context.registry.decide(principal, id, outcome, (account) => canUse(grant, account), reason)
    context.log(
      `dashboard ${verb} run=${id} iss=${principal.iss} sub=${principal.sub} result=${result.status}${loggedReason(
        reason
      )}`
    )
    switch (result.status) {
      case 'ok':
        return done(ownBack(form.get('back'), '/approvals'))
      case 'own-run':
        return page.send(res, 403, 'Not yours to decide', '<p>A run is approved by somebody else than who asked.</p>')
      case 'not-waiting':
        return page.send(res, 409, 'Decided', `<p>The run is ${h(result.state)}, it does not wait any more.</p>`)
      case 'already-approved':
        return page.send(
          res,
          409,
          'Approved',
          '<p>You approved all you can, the run waits for somebody who uses the other accounts.</p>'
        )
      default:
        return page.send(res, 404, 'Not found', '<p>There is no such run you may decide about.</p>')
    }
  }
  const [, hash, verb] = versionDecision as RegExpExecArray
  if (!context.proposals || !context.definitions || !HASH_PATTERN.test(hash)) {
    return page.send(res, 404, 'Not found', '<p>There is no such version.</p>')
  }
  const outcome = verb === 'approve' ? 'approved' : 'rejected'
  try {
    const result = await decideProposal(context.definitions, context.proposals, grant, principal, hash, outcome, reason)
    context.log(
      `dashboard ${verb} proposal=${hash} iss=${principal.iss} sub=${principal.sub} result=${
        result.status
      }${loggedReason(reason)}`
    )
    switch (result.status) {
      case 'ok':
        return done('/approvals')
      case 'own-proposal':
        return page.send(
          res,
          403,
          'Not yours to decide',
          '<p>A version is approved by somebody else than who proposed it.</p>'
        )
      case 'not-waiting':
        return page.send(res, 409, 'Decided', `<p>The version is ${h(result.state)}, it does not wait any more.</p>`)
      default:
        return page.send(res, 404, 'Not found', '<p>There is no such version you may decide about.</p>')
    }
  } catch (e) {
    if (e instanceof DefinitionError) {
      return page.send(res, 400, 'Does not load', `<p>The build file does not load: ${h(e.message)}</p>`)
    }
    throw e
  }
}

// The reason of a decision for the log, on one line, as the API writes it.
function loggedReason(reason: string | undefined): string {
  return reason ? ` reason=${quote(reason)}` : ''
}

// A path of the dashboard a form goes back to, never another host.
function ownBack(value: string | null, fallback: string): string {
  return value && /^\/[A-Za-z0-9_\-/?=&.,]*$/.test(value) && !value.startsWith('//') ? value : fallback
}

class Page {
  private capacityRead?: Promise<Capacity | undefined>

  constructor(
    private readonly context: DashboardContext,
    private readonly viewer: Viewer,
    private readonly now: number
  ) {}

  // the token of the forms: of this person and this sign-in, so a token that leaked dies
  // with its session
  private get csrf(): string {
    const { iss, sub } = this.viewer.principal
    return this.context.sign(`dashboard\0csrf\0${iss}\0${sub}\0${this.context.session ?? 'token'}`)
  }

  // An API token is new; a sign-in in the browser has to be of the last minutes to decide.
  signedInLately(): boolean {
    const at = this.context.signedInAt
    return at === undefined || this.now - at <= DECIDE_WITHIN_MS
  }

  signInAgain(back: string): string {
    return `<a href="/.hammerkit/signin?path=${h(encodeURIComponent(back))}">Sign in again</a> to decide.`
  }

  validCsrf(value: string | null): boolean {
    if (value === null) {
      return false
    }
    const given = Buffer.from(value)
    const expected = Buffer.from(this.csrf)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  send(
    res: ServerResponse,
    status: number,
    title: string,
    body: string,
    options: { refresh?: boolean; nav?: Nav } = {}
  ): void {
    sendPage(res, {
      status,
      title,
      body,
      ...(options.refresh ? { refresh: REFRESH_SECONDS } : {}),
      ...(options.nav ? { nav: options.nav } : {}),
      who: `${h(this.viewer.principal.sub)}${this.viewer.grant.observe ? ' · observes' : ''}`,
      waiting: this.waitingForMe(),
    })
  }

  readCapacity(): Promise<Capacity | undefined> {
    this.capacityRead ??= this.context.capacity
      ? this.context.capacity
          .read(this.context.registry.all())
          .then((capacity) => visibleCapacity(capacity, this.viewer))
          .catch(() => undefined)
      : Promise.resolve(undefined)
    return this.capacityRead
  }

  // ---- overview ----

  overview(overview: Overview, capacity: Capacity | undefined): string {
    const { places } = overview
    const slots = [
      ...places.runs.map(
        (run) =>
          `<li class="slot${run.owner ? '' : ' mine'}"><a href="/runs/${h(run.id)}">${h(run.id)}</a><span>${this.work(
            run
          )}${this.ownerOf(run)}</span><small>${
            run.startedAt ? `running for ${span(ranMs(run, this.now))}` : ''
          }</small></li>`
      ),
      ...Array.from({ length: places.others }, () => '<li class="slot other"><span>somebody else</span></li>'),
      ...Array.from(
        { length: Math.max(0, places.used - places.runs.length - places.others) },
        () => '<li class="slot warn"><span>taken by no running run</span></li>'
      ),
      ...Array.from(
        { length: Math.max(0, places.max - places.used) },
        () => '<li class="slot free"><span>free</span></li>'
      ),
    ]
    const queue =
      overview.queue.length === 0
        ? '<p class="quiet">Nothing waits for a place.</p>'
        : `<ol class="queue">${overview.queue
            .map(
              (entry) =>
                `<li class="${entry.mine ? 'mine' : 'other'}"><span>${
                  entry.run
                    ? `<a href="/runs/${h(entry.run.id)}">${h(entry.run.id)}</a> ${this.work(entry.run)}${this.ownerOf(
                        entry.run
                      )}`
                    : 'a run of somebody else'
                }</span><small>${entry.run ? `waiting ${span(waitedMs(entry.run, this.now))} · ` : ''}waits: ${h(
                  describeWait(entry.waitsFor, entry.mine, false)
                )}</small></li>`
            )
            .join('')}</ol>`
    const approvals =
      overview.approvals.runs.length === 0
        ? ''
        : `<ul class="list">${overview.approvals.runs
            .map((run) => {
              const open = (run.approvals ?? []).filter((approval) => !approval.approvedBy)
              return `<li><a href="/runs/${h(run.id)}">${h(run.id)}</a> ${this.work(run)}${this.ownerOf(
                run
              )} <small>needs ${open
                .map((approval) => `<code>${h(approval.account)}</code>`)
                .join(', ')} until ${this.time(run.approvals?.[0]?.expiresAt)}</small></li>`
            })
            .join('')}</ul>`
    return `<section><h2>Places <small>${places.used} of ${
      places.max
    } taken (runs.maxConcurrent)</small></h2><ul class="slots">${slots.join('')}</ul></section>
<section><h2>Queue <small>in the order runs start</small></h2>${queue}</section>
${capacity ? this.capacitySummary(capacity) : ''}
<section><h2>Your limits <small>and the runs that count against them</small></h2><div class="meters">${[
      this.meter('Running', overview.limits.running, 'runs.limits.running'),
      this.meter('Queued', overview.limits.queued, 'runs.limits.queued'),
      this.meter('Waiting for approval', overview.limits.waiting, 'runs.limits.waiting'),
      this.meter('Service runs', overview.limits.services, 'runs.up.limits.up'),
    ].join('')}</div></section>
<section><h2>Waiting for an approval <small>${overview.approvals.waiting} of at most ${
      overview.approvals.max
    } on the server · <a href="/approvals">decide</a></small></h2>${
      approvals || '<p class="quiet">None you may see.</p>'
    }</section>
<section><h2>Service runs <small>${overview.services.open}${
      overview.services.max !== undefined ? ` of ${overview.services.max}` : ''
    } on the server</small></h2>${
      overview.services.runs.length > 0
        ? this.serviceTable(overview.services.runs)
        : '<p class="quiet">None you may see is starting, up or asleep.</p>'
    }</section>`
  }

  private meter(name: string, meter: Meter, key: string): string {
    const full = meter.limit !== undefined && meter.used >= meter.limit
    return `<div class="meter${full ? ' full' : ''}"><strong>${h(name)} ${meter.used}${
      meter.limit !== undefined ? ` of ${meter.limit}` : ''
    }</strong>${bar(meter.used, meter.limit)}<small>${
      meter.runs.length > 0 ? meter.runs.map((id) => `<a href="/runs/${h(id)}">${h(id)}</a>`).join(', ') : 'none'
    }</small><small class="quiet">${h(key)}</small></div>`
  }

  // ---- service runs ----

  services(runs: Run[]): string {
    const groups: [string, Run[]][] = [
      ['Up', runs.filter((run) => run.state === 'up')],
      ['Asleep', runs.filter((run) => run.state === 'asleep')],
      ['Starting', runs.filter((run) => ['awaiting-approval', 'queued', 'running'].includes(run.state))],
      [
        'Ended in the last day',
        runs.filter((run) => isFinal(run.state) && this.now - Date.parse(run.finishedAt ?? run.createdAt) < DAY),
      ],
    ]
    return groups
      .map(
        ([name, list]) =>
          `<section><h2>${h(name)} <small>${list.length}</small></h2>${
            list.length > 0
              ? this.serviceTable(list.map((run) => toListedRun(this.viewer, run)))
              : '<p class="quiet">None.</p>'
          }</section>`
      )
      .join('')
  }

  private serviceTable(runs: ListedRun[]): string {
    return `<table><thead><tr><th>Name</th><th>State</th><th>Endpoints</th><th>Source</th><th>Ends</th><th>Sleeps</th><th></th></tr></thead><tbody>${runs
      .map((run) => {
        const endpoints = (run.up?.endpoints ?? [])
          .map((endpoint) =>
            endpoint.url
              ? `<a href="${h(endpoint.url)}" rel="noreferrer">${h(endpoint.service)}:${endpoint.port}</a>`
              : `${h(endpoint.service)}:${endpoint.port}`
          )
          .join('<br>')
        return `<tr><td><a href="/runs/${h(run.id)}">${h(run.up?.name ?? run.id)}</a>${this.ownerOf(run)}<br><small>${h(
          (run.up?.services ?? []).join(', ')
        )}</small></td><td>${this.state(run.state)}${
          run.wakes ? `<br><small>woken ${run.wakes}×</small>` : ''
        }</td><td data-label="Endpoints">${endpoints || '<span class="quiet">none</span>'}</td><td>${this.source(
          run
        )}</td><td data-label="Ends">${
          run.expiresAt ? this.time(run.expiresAt) : '<span class="quiet">once up</span>'
        }</td><td data-label="Sleeps">${
          run.state === 'up' && run.sleepsAt
            ? this.time(run.sleepsAt)
            : run.up?.sleepTtl
              ? `after ${h(formatDuration(run.up.sleepTtl))}`
              : '<span class="quiet">never</span>'
        }</td><td>${this.actions(run, true)}</td></tr>`
      })
      .join('')}</tbody></table>`
  }

  // ---- runs ----

  // whether the viewer sees more than their own runs
  private get seesOthers(): boolean {
    return this.viewer.grant.observe || !!this.viewer.activity
  }

  runs(params: URLSearchParams): string {
    const who = params.get('who') ?? (this.seesOthers ? 'all' : 'mine')
    const all = who === 'all'
    const state = params.get('state') ?? ''
    const kind = params.get('kind') ?? ''
    const text = (params.get('q') ?? '').slice(0, 100)
    const states =
      state === 'active' ? ACTIVE : state && STATES.includes(state as RunState) ? [state as RunState] : undefined
    const runs = filterRuns(this.context.registry.all(), this.viewer, {
      scope: all ? 'visible' : 'mine',
      ...(states ? { states } : {}),
      ...(kind === 'tasks' || kind === 'services' ? { kind } : {}),
    }).filter((run) => !text || matchesText(run, text))
    const option = (value: string, label: string, current: string) =>
      `<option value="${h(value)}"${value === current ? ' selected' : ''}>${h(label)}</option>`
    const form = `<form method="get" class="filter"><select name="who" aria-label="Whose">${option(
      'all',
      this.seesOthers ? 'everybody' : 'mine and those I may see',
      who
    )}${option('mine', 'mine', who)}</select><select name="state" aria-label="State">${option(
      '',
      'any state',
      state
    )}${option('active', 'not over', state)}${STATES.map((value) => option(value, value, state)).join(
      ''
    )}</select><select name="kind" aria-label="Kind">${option('', 'tasks and services', kind)}${option(
      'tasks',
      'tasks',
      kind
    )}${option('services', 'services', kind)}</select><input name="q" value="${h(
      text
    )}" placeholder="task, service, ref, person, id" aria-label="Search"><button>Show</button></form>`
    if (runs.length === 0) {
      return `${form}<p class="quiet">No runs the server keeps are like that.</p>`
    }
    return `${form}<table><thead><tr><th>Run</th><th>State</th><th>What</th><th>Source</th><th>Created</th><th class="num">Waited</th><th class="num">Ran</th></tr></thead><tbody>${runs
      .map((run) => {
        const listed = toListedRun(this.viewer, run)
        const queue = queuePlace(this.context.registry, this.viewer, run)
        return `<tr><td><a href="/runs/${h(run.id)}">${h(run.id)}</a>${this.ownerOf(listed)}</td><td>${this.state(
          run.state
        )}${queue ? `<br><small>${queue.position}. in the queue</small>` : ''}</td><td>${this.work(listed)}${
          listed.error ? `<br><small class="error">${h(cut(listed.error, 200))}</small>` : ''
        }</td><td>${this.source(run)}</td><td data-label="Created">${this.time(
          run.createdAt
        )}</td><td class="num" data-label="Waited">${span(
          waitedMs(run, this.now)
        )}</td><td class="num" data-label="Ran">${span(ranMs(run, this.now))}</td></tr>`
      })
      .join('')}</tbody></table>`
  }

  run(run: Run, params: URLSearchParams): string {
    const owner = owns(this.viewer, run)
    // the results, the plan and the log are for its owner, who decides about it and observe
    const full = mayRead(this.viewer, run)
    const listed = toListedRun(this.viewer, run)
    const queue = queuePlace(this.context.registry, this.viewer, run)
    const facts: [string, string][] = [
      [
        'State',
        `${this.state(run.state)}${listed.error ? ` <span class="error">${h(cut(listed.error, 2000))}</span>` : ''}`,
      ],
      ...(owner
        ? []
        : ([['Owner', `<code>${h(run.owner.sub)}</code> <small class="quiet">${h(run.owner.iss)}</small>`]] as [
            string,
            string,
          ][])),
      ['What', this.work(listed)],
      ['Source', this.source(run)],
      ['Build file', `<code>${h(run.definition)}</code>`],
      ...(run.accounts.length > 0
        ? ([['Accounts', run.accounts.map((a) => `<code>${h(a)}</code>`).join(', ')]] as [string, string][])
        : []),
      ['Created', this.time(run.createdAt)],
    ]
    const waited = waitedMs(run, this.now)
    if (waited !== undefined) {
      facts.push(['Waited for a place', `${span(waited)}${run.state === 'queued' ? ' so far' : ''}`])
    }
    if (run.startedAt) {
      facts.push(['Started', this.time(run.startedAt)])
    }
    const ran = ranMs(run, this.now)
    if (ran !== undefined) {
      facts.push([run.up ? 'Took to be up' : 'Ran', `${span(ran)}${run.finishedAt || run.upAt ? '' : ' so far'}`])
    }
    if (run.finishedAt) {
      facts.push(['Finished', this.time(run.finishedAt)])
    }
    if (queue) {
      facts.push(['Queue', `${queue.position}. waits: ${h(describeWait(queue.waitsFor, owner, false))}`])
    }
    for (const approval of run.approvals ?? []) {
      facts.push([
        `Approval of <code>${h(approval.account)}</code>`,
        approval.approvedBy
          ? `approved by <code>${h(approval.approvedBy.sub)}</code>`
          : `waits until ${this.time(approval.expiresAt)}`,
      ])
    }
    if (listed.up) {
      facts.push(
        ['Services', h(listed.up.services.join(', '))],
        [
          'Endpoints',
          listed.up.endpoints
            .map((e) =>
              e.url ? `<a href="${h(e.url)}" rel="noreferrer">${h(e.url)}</a>` : `${h(e.service)}:${e.port}`
            )
            .join('<br>') || '<span class="quiet">none</span>',
        ]
      )
      if (run.upAt) {
        facts.push(['Up since', this.time(run.upAt)])
      }
      if (run.expiresAt) {
        facts.push(['Ends', this.time(run.expiresAt)])
      }
      if (listed.up.sleepTtl) {
        facts.push([
          'Sleeps',
          `after ${h(formatDuration(listed.up.sleepTtl))} without a request${
            run.state === 'up' && run.sleepsAt ? `, next at ${this.time(run.sleepsAt)}` : ''
          }${run.wakes ? `, woken ${run.wakes}×` : ''}`,
        ])
      }
    }
    const decide =
      run.state === 'awaiting-approval' && !owner && decides(this.viewer, run)
        ? this.decideRun(run, `/runs/${run.id}`)
        : ''
    const summary = `<dl class="facts">${facts
      .map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`)
      .join('')}</dl>${this.actions(listed, false)}${decide}`
    const tasks = this.results(run, full)
    if (!full) {
      return `${summary}${tasks}<p class="quiet">What the tasks run, why they failed and the log are for the owner of the run and who decides about it.</p>`
    }
    return `${summary}${tasks}${run.plan ? this.plan(run.plan, run.options) : ''}${this.logTail(run, params)}`
  }

  private results(run: Run, full: boolean): string {
    const results = Object.entries(run.results ?? {})
    if (results.length === 0) {
      return ''
    }
    const usual = this.usual(run)
    return `<section><h2>Tasks</h2><table><thead><tr><th>Task</th><th>Status</th><th class="num">Took</th><th class="num">Usually</th>${
      full ? '<th>Cache</th><th>Exit</th>' : ''
    }</tr></thead><tbody>${results
      .map(([task, result]) => {
        const stats = usual.get(task)
        return `<tr><td>${
          full ? `<a href="?task=${encodeURIComponent(task)}#log">${h(task)}</a>` : h(task)
        }</td><td>${this.state(result.status)}${
          full && result.error ? `<br><small class="error">${h(cut(result.error, 500))}</small>` : ''
        }</td><td class="num" data-label="Took">${span(result.durationMs)}</td><td class="num" data-label="Usually">${
          stats?.medianMs !== undefined
            ? `${span(stats.medianMs)} <small class="quiet">of ${stats.succeeded + stats.failed}</small>`
            : ''
        }</td>${
          full
            ? `<td data-label="Cache">${
                result.cache?.hit
                  ? 'hit'
                  : result.cache?.causes?.length
                    ? `<small>${result.cache.causes.map((cause) => h(cut(cause, 200))).join('<br>')}</small>`
                    : ''
              }</td><td data-label="Exit">${result.exitCode ?? ''}</td>`
            : ''
        }</tr>`
      })
      .join('')}</tbody></table></section>`
  }

  // per task of the run, what it took in the runs of its repository the viewer may see
  private usual(run: Run): Map<string, TaskStats> {
    const repo = run.source.type === 'upload' ? undefined : run.source.repo
    const others = filterRuns(this.context.registry.all(), this.viewer, { scope: 'visible' }).filter(
      (other) => other.source.type !== 'upload' && other.source.repo === repo
    )
    const stats = getTaskStats(
      others.map((other) => toListedRun(this.viewer, other)),
      this.now
    )
    return new Map(stats.map((entry) => [entry.task, entry]))
  }

  // what the tasks and services do, as who approves reads it
  private plan(plan: Record<string, TaskPlan>, options: Run['options'] | undefined): string {
    const args = (options as { args?: unknown } | undefined)?.args
    return `<section><h2>What it runs</h2>${
      Array.isArray(args) && args.length > 0
        ? `<p>Arguments: ${args.map((arg) => `<code>${h(JSON.stringify(arg))}</code>`).join(' ')}</p>`
        : ''
    }${planEntries(plan)}</section>`
  }

  private logTail(run: Run, params: URLSearchParams): string {
    const logs = this.context.registry.logsOf(run.id)
    if (!logs) {
      return ''
    }
    const names = logs.index.names()
    const task = params.get('task') ?? undefined
    const chosen = task !== undefined && names.includes(task) ? task : undefined
    const page = readLogs(
      logs.events,
      logs.index,
      { ...(chosen ? { task: chosen } : {}), tail: LOG_LINES, limit: LOG_LINES, ignoreCase: false, context: 0 },
      logs.truncated
    )
    const query = chosen ? `?task=${encodeURIComponent(chosen)}` : ''
    return `<section id="log"><h2>Log <small>the last ${Math.min(LOG_LINES, page.total)} of ${page.total} lines${
      page.truncated ? ', cut off at runs.maxLogBytes' : ''
    } · <a href="/runs/${h(run.id)}/log${query}">all of it</a> · <a href="/runs/${h(
      run.id
    )}/log.txt${query}">download</a></small></h2>${this.logNames(run, names, chosen, '', '#log')}<pre class="log">${
      this.logLines(page.lines, !chosen) || '<span class="quiet">nothing yet</span>'
    }</pre></section>`
  }

  // the tasks, services and the server's own lines a log can be narrowed to
  private logNames(run: Run, names: string[], chosen: string | undefined, path: string, anchor: string): string {
    const services = new Set(
      run.up?.services ??
        Object.entries(run.plan ?? {})
          .filter(([, p]) => p.kind === 'service')
          .map(([n]) => n)
    )
    const base = `/runs/${h(run.id)}${path}`
    return `<nav class="tasks"><a href="${base}${anchor}"${chosen ? '' : ' aria-current="page"'}>all</a>${names
      .map(
        (name) =>
          `<a href="${base}?task=${encodeURIComponent(name)}${anchor}"${
            name === chosen ? ' aria-current="page"' : ''
          }>${h(name)}${
            name === 'hammerkit'
              ? ' <small class="quiet">(server)</small>'
              : services.has(name)
                ? ' <small class="quiet">(service)</small>'
                : ''
          }</a>`
      )
      .join('')}</nav>`
  }

  private logLines(lines: LogLine[], named: boolean): string {
    return lines
      .map(
        (line) =>
          `<span class="${line.stream}">${named ? `<b>[${h(line.task)}]</b> ` : ''}${
            line.match ? `<mark>${h(printableLine(line.text))}</mark>` : h(printableLine(line.text))
          }</span>`
      )
      .join('\n')
  }

  // the whole log, a thousand lines a page, from the end; with a text to look for
  log(run: Run, params: URLSearchParams): string {
    const logs = this.context.registry.logsOf(run.id)
    if (!logs) {
      return '<p class="quiet">The server keeps no log of this run.</p>'
    }
    const names = logs.index.names()
    const task = params.get('task') ?? undefined
    const chosen = task !== undefined && names.includes(task) ? task : undefined
    const grep = (params.get('grep') ?? '').replace(/[\r\n]/g, ' ').slice(0, 200) || undefined
    const total = chosen ? logs.index.lines(chosen).length : logs.index.size
    const fromParam = Number(params.get('from'))
    const from =
      Number.isInteger(fromParam) && fromParam >= 1 ? fromParam : grep ? 1 : Math.max(1, total - MAX_LOG_LINES + 1)
    const page = readLogs(
      logs.events,
      logs.index,
      {
        ...(chosen ? { task: chosen } : {}),
        from,
        limit: MAX_LOG_LINES,
        ...(grep ? { grep } : {}),
        ignoreCase: true,
        context: grep ? 2 : 0,
      },
      logs.truncated
    )
    const query = (more: Record<string, string>) => {
      const search = new URLSearchParams({ ...(chosen ? { task: chosen } : {}), ...(grep ? { grep } : {}), ...more })
      return `/runs/${h(run.id)}/log?${h(search.toString())}`
    }
    const first = page.lines[0]?.line
    const earlier =
      !grep && first !== undefined && first > 1
        ? `<a href="${query({ from: String(Math.max(1, first - MAX_LOG_LINES)) })}">earlier</a>`
        : ''
    const later = page.next !== undefined ? `<a href="${query({ from: String(page.next) })}">later</a>` : ''
    const search = `<form method="get" class="filter">${
      chosen ? `<input type="hidden" name="task" value="${h(chosen)}">` : ''
    }<input name="grep" value="${h(
      grep ?? ''
    )}" placeholder="look for a text" aria-label="Look for"><button>Look</button>${
      grep ? ` <a href="/runs/${h(run.id)}/log${chosen ? `?task=${encodeURIComponent(chosen)}` : ''}">show all</a>` : ''
    }</form>`
    return `<p><a href="/runs/${h(run.id)}">back to the run</a> · <a href="/runs/${h(run.id)}/log.txt${
      chosen ? `?task=${encodeURIComponent(chosen)}` : ''
    }">download</a></p>${this.logNames(run, names, chosen, '/log', '')}${search}<p class="quiet">${
      page.lines.length > 0
        ? `lines ${page.lines[0].line} to ${page.lines[page.lines.length - 1].line} of ${total}`
        : `${total} lines`
    }${grep ? `, with “${h(grep)}” and two lines around` : ''}${
      page.truncated ? ', cut off at runs.maxLogBytes' : ''
    }</p><div class="pager">${earlier}${later}</div><pre class="log">${
      this.logLines(page.lines, !chosen) || '<span class="quiet">nothing</span>'
    }</pre><div class="pager">${earlier}${later}</div>`
  }

  // the log as a text file: what the tasks printed, as they printed it
  logText(res: ServerResponse, run: Run, params: URLSearchParams): void {
    const logs = this.context.registry.logsOf(run.id)
    const names = logs?.index.names() ?? []
    const task = params.get('task') ?? undefined
    const chosen = task !== undefined && names.includes(task) ? task : undefined
    const lines: string[] = []
    if (logs) {
      const selected = chosen ? logs.index.lines(chosen) : undefined
      const total = selected ? selected.length : logs.index.size
      for (let position = 0; position < total; position++) {
        const line = logs.index.text(logs.events, selected ? selected[position] : position)
        lines.push(chosen ? line.text : `[${line.task}] ${line.text}`)
      }
      if (logs.truncated) {
        lines.push('[hammerkit] the log was cut off at runs.maxLogBytes')
      }
    }
    res.writeHead(200, {
      ...HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${run.id}${
        chosen ? `-${chosen.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''
      }.log"`,
    })
    res.end(lines.join('\n') + (lines.length > 0 ? '\n' : ''))
  }

  // ---- tasks ----

  tasks(params: URLSearchParams): string {
    const text = (params.get('q') ?? '').slice(0, 100).toLowerCase()
    const runs = filterRuns(this.context.registry.all(), this.viewer, { scope: 'visible' })
    const stats = getTaskStats(
      runs.map((run) => toListedRun(this.viewer, run)),
      this.now
    ).filter((entry) => !text || `${entry.repo} ${entry.task}`.toLowerCase().includes(text))
    const form = `<form method="get" class="filter"><input name="q" value="${h(
      text
    )}" placeholder="task or repository" aria-label="Search"><button>Show</button></form>`
    const note = `<p class="quiet">Over the runs the server keeps (runs.keep)${
      this.seesOthers ? ', of everybody' : ' that you may see'
    }. Took counts the runs that executed the task, not the ones that took it from the cache.</p>`
    if (stats.length === 0) {
      return `${form}${note}<p class="quiet">No task ran in the runs the server keeps.</p>`
    }
    return `${form}${note}<table><thead><tr><th>Task</th><th>Repository</th><th>Last</th><th class="num">Runs</th><th class="num">Failed</th><th class="num">Cached</th><th class="num">Median</th><th class="num">90%</th><th class="num">Waited</th></tr></thead><tbody>${stats
      .map(
        (entry) =>
          `<tr><td><code>${h(entry.task)}</code></td><td>${h(entry.repo)}</td><td data-label="Last">${this.state(
            entry.last.status
          )} ${this.time(entry.last.at)}${
            entry.last.durationMs !== undefined
              ? ` <small class="quiet">took ${span(entry.last.durationMs)}</small>`
              : ''
          }</td><td class="num" data-label="Runs">${entry.runs}</td><td class="num" data-label="Failed">${
            entry.failed || ''
          }</td><td class="num" data-label="Cached">${
            entry.cached || ''
          }</td><td class="num" data-label="Median">${span(entry.medianMs)}</td><td class="num" data-label="90%">${span(
            entry.p90Ms
          )}</td><td class="num" data-label="Waited">${span(entry.medianWaitMs)}</td></tr>`
      )
      .join('')}</tbody></table>`
  }

  // ---- approvals ----

  // runs and versions that wait for the viewer to decide
  private waitingForMe(): number {
    const runs = this.context.registry.waiting().filter((run) => this.mayDecideRun(run)).length
    const versions = (this.context.proposals?.waiting() ?? []).filter((proposal) =>
      this.mayDecideVersion(proposal)
    ).length
    return runs + versions
  }

  mayDecideRun(run: Run): boolean {
    return (
      run.state === 'awaiting-approval' &&
      !owns(this.viewer, run) &&
      (run.approvals ?? []).some((approval) => !approval.approvedBy && canUse(this.viewer.grant, approval.account))
    )
  }

  private mayDecideVersion(proposal: Proposal): boolean {
    const { iss, sub } = this.viewer.principal
    const mine = proposal.proposedBy.iss === iss && proposal.proposedBy.sub === sub
    return proposal.state === 'waiting' && !mine && mayApprove(this.viewer.grant, proposal)
  }

  maySeeProposal(proposal: Proposal): boolean {
    const { iss, sub } = this.viewer.principal
    return (proposal.proposedBy.iss === iss && proposal.proposedBy.sub === sub) || mayPublish(this.viewer.grant)
  }

  approvals(): string {
    const waiting = this.context.registry.waiting()
    const mine = waiting.filter((run) => this.mayDecideRun(run))
    const own = waiting.filter((run) => owns(this.viewer, run))
    const others = waiting.filter(
      (run) => !this.mayDecideRun(run) && !owns(this.viewer, run) && maySee(this.viewer, run)
    )
    const runCard = (run: Run, decide: boolean) => {
      const listed = toListedRun(this.viewer, run)
      const open = (run.approvals ?? []).filter((approval) => !approval.approvedBy)
      return `<div class="card"><dl class="facts"><dt>Run</dt><dd><a href="/runs/${h(run.id)}">${h(
        run.id
      )}</a>${this.ownerOf(listed)}</dd><dt>What</dt><dd>${this.work(listed)}</dd><dt>Source</dt><dd>${this.source(
        run
      )}</dd><dt>Needs</dt><dd>${open.map((approval) => `<code>${h(approval.account)}</code>`).join(', ')}${
        (run.approvals ?? []).some((approval) => approval.approvedBy)
          ? ` <small class="quiet">(${(run.approvals ?? [])
              .filter((approval) => approval.approvedBy)
              .map((approval) => `${h(approval.account)} approved by ${h(approval.approvedBy?.sub ?? '')}`)
              .join(', ')})</small>`
          : ''
      }</dd><dt>Decide before</dt><dd>${this.time(run.approvals?.[0]?.expiresAt)}</dd></dl>${
        decide && run.plan ? `<details><summary>What it runs</summary>${planEntries(run.plan)}</details>` : ''
      }${decide ? this.decideRun(run, '/approvals') : ''}</div>`
    }
    const proposals = this.context.proposals?.all().filter((proposal) => this.maySeeProposal(proposal)) ?? []
    const open = proposals.filter((proposal) => proposal.state === 'waiting')
    const decided = proposals
      .filter((proposal) => proposal.state !== 'waiting' && this.now - Date.parse(proposal.decidedAt ?? '') < DAY)
      .slice(0, 20)
    const versionCard = (proposal: Proposal) => {
      const decide = this.mayDecideVersion(proposal)
      const flagged = Object.entries(proposal.plan).filter(([, entry]) => entry.flags.length > 0)
      return `<div class="card"><dl class="facts"><dt>Version</dt><dd><a href="/approvals/versions/${h(
        proposal.hash
      )}"><code>${h(proposal.hash.slice(0, 19))}…</code></a></dd><dt>Proposed by</dt><dd><code>${h(
        proposal.proposedBy.sub
      )}</code> ${this.time(proposal.createdAt)}</dd><dt>Tasks</dt><dd>${
        h(proposal.tasks.join(', ')) || '<span class="quiet">none</span>'
      }${proposal.services.length > 0 ? `<br><small>services ${h(proposal.services.join(', '))}</small>` : ''}</dd>${
        proposal.accounts.length > 0
          ? `<dt>Accounts</dt><dd>${proposal.accounts.map((a) => `<code>${h(a)}</code>`).join(', ')}${
              proposal.missing.length > 0
                ? ` <small>(who approves uses ${proposal.missing
                    .map((a) => `<code>${h(a)}</code>`)
                    .join(', ')})</small>`
                : ''
            }</dd>`
          : ''
      }${
        flagged.length > 0
          ? `<dt>Look at</dt><dd class="flag">${flagged
              .map(([name, entry]) => `${h(name)} (${h(entry.flags.join(', '))})`)
              .join(', ')}</dd>`
          : ''
      }<dt>Decide before</dt><dd>${this.time(proposal.expiresAt)}</dd></dl>${
        decide
          ? this.decideForm(`/approvals/versions/${h(proposal.hash)}`, 'Publish', '/approvals')
          : !this.maySeeProposal(proposal) || mayPublish(this.viewer.grant)
            ? ''
            : '<p class="quiet">Waits for somebody who may publish.</p>'
      }</div>`
    }
    const section = (title: string, body: string, empty: string) =>
      `<section><h2>${title}</h2>${body || `<p class="quiet">${empty}</p>`}</section>`
    return [
      section(
        `Runs you decide about <small>${mine.length}</small>`,
        mine.map((run) => runCard(run, true)).join(''),
        'No run waits for an account you use.'
      ),
      own.length > 0 ? section('Your runs that wait', own.map((run) => runCard(run, false)).join(''), '') : '',
      others.length > 0
        ? section('Runs of others that wait', others.map((run) => runCard(run, false)).join(''), '')
        : '',
      section(
        `Build file versions to publish <small>${open.length}</small>`,
        open.map(versionCard).join(''),
        this.context.proposals
          ? mayPublish(this.viewer.grant)
            ? 'No version waits to be published.'
            : 'You may not publish build files, and proposed none that waits.'
          : 'The server takes no proposals.'
      ),
      decided.length > 0
        ? section(
            'Decided in the last day',
            `<table><thead><tr><th>Version</th><th>State</th><th>Proposed by</th><th>Decided</th></tr></thead><tbody>${decided
              .map(
                (proposal) =>
                  `<tr><td><code>${h(proposal.hash.slice(0, 19))}…</code></td><td>${this.state(proposal.state)}${
                    proposal.reason ? `<br><small>${h(cut(proposal.reason, 200))}</small>` : ''
                  }</td><td>${h(proposal.proposedBy.sub)}</td><td>${
                    proposal.decidedBy ? `${h(proposal.decidedBy.sub)} ` : ''
                  }${this.time(proposal.decidedAt)}</td></tr>`
              )
              .join('')}</tbody></table>`,
            ''
          )
        : '',
    ].join('')
  }

  // one proposed version whole: its plan and its files, as who decides reads them
  version(proposal: Proposal): string {
    const bundle = proposal.state === 'waiting' ? this.context.proposals?.bundle(proposal.hash) : undefined
    const facts = `<dl class="facts"><dt>Hash</dt><dd><code>${h(
      proposal.hash
    )}</code></dd><dt>State</dt><dd>${this.state(proposal.state)}${
      proposal.reason ? ` ${h(proposal.reason)}` : ''
    }</dd><dt>Proposed by</dt><dd><code>${h(proposal.proposedBy.sub)}</code> ${this.time(
      proposal.createdAt
    )}</dd><dt>Entry</dt><dd><code>${h(proposal.entry)}</code></dd>${
      proposal.annotations && Object.keys(proposal.annotations).length > 0
        ? `<dt>Annotations</dt><dd>${Object.entries(proposal.annotations)
            .map(([key, value]) => `<code>${h(key)}=${h(String(value))}</code>`)
            .join(' ')}</dd>`
        : ''
    }</dl>`
    const decide = this.mayDecideVersion(proposal)
      ? this.decideForm(`/approvals/versions/${h(proposal.hash)}`, 'Publish', '/approvals')
      : ''
    const files = bundle
      ? `<section><h2>Files <small>${Object.keys(bundle.files).length}</small></h2>${Object.entries(bundle.files)
          .map(([name, text]) => `<div class="file"><h3><code>${h(name)}</code></h3><pre>${h(text)}</pre></div>`)
          .join('')}</section>`
      : '<p class="quiet">The files are kept only while the version waits.</p>'
    return `<p><a href="/approvals">back to the approvals</a></p>${facts}${decide}<section><h2>What it runs</h2>${planEntries(
      proposal.plan
    )}</section>${files}`
  }

  private decideRun(run: Run, back: string): string {
    return this.decideForm(`/approvals/runs/${h(run.id)}`, 'Approve', back)
  }

  private decideForm(action: string, yes: string, back: string): string {
    if (!this.signedInLately()) {
      return `<p class="quiet">Your sign-in is older than ${DECIDE_WITHIN_MS / 60_000} minutes. ${this.signInAgain(
        back
      )}</p>`
    }
    const hidden = `<input type="hidden" name="csrf" value="${h(
      this.csrf
    )}"><input type="hidden" name="back" value="${h(back)}">`
    return `<div class="actions"><form method="post" action="${action}/approve">${hidden}<button class="good">${h(
      yes
    )}</button></form><form method="post" action="${action}/reject">${hidden}<input name="reason" maxlength="500" placeholder="why not (optional)" aria-label="Why not"><button class="danger">Reject</button></form></div>`
  }

  // ---- capacity ----

  private capacitySummary(capacity: Capacity): string {
    return `<section><h2>Capacity <small><a href="/capacity">more</a></small></h2><div class="meters">${this.capacityMeters(
      capacity
    )}</div></section>`
  }

  private capacityMeters(capacity: Capacity): string {
    const { machines, runs } = capacity
    const meter = (name: string, kind: 'cpu' | 'memory') => {
      const format = kind === 'cpu' ? (n: number) => `${formatCpu(n)} cores` : formatMemory
      const max = machines?.allocatable[kind]
      const used = runs.used?.[kind]
      const requested = runs.requested[kind]
      const usedAll = machines?.used?.[kind]
      const lines = [
        requested !== undefined && capacity.backend === 'kubernetes' ? `runs requested ${format(requested)}` : '',
        used !== undefined ? `runs use ${format(used)}` : '',
        usedAll !== undefined
          ? `${capacity.backend === 'kubernetes' ? 'the nodes use' : 'the machine uses'} ${format(usedAll)}`
          : '',
      ].filter(Boolean)
      return `<div class="meter"><strong>${name}${
        max !== undefined
          ? ` <small class="quiet">${format(max)} on ${machines?.count} ${
              capacity.backend === 'kubernetes' ? (machines?.count === 1 ? 'node' : 'nodes') : 'machine'
            }</small>`
          : ''
      }</strong>${bar(capacity.backend === 'kubernetes' ? requested ?? used : used ?? usedAll, max, usedAll)}<small>${
        lines.join(' · ') || '<span class="quiet">not known</span>'
      }</small></div>`
    }
    return `${meter('CPU', 'cpu')}${meter('Memory', 'memory')}${
      machines?.load
        ? `<div class="meter"><strong>Load</strong><small>${machines.load
            .map((l) => l.toFixed(2))
            .join(' · ')} <span class="quiet">(1, 5, 15 min)</span></small></div>`
        : ''
    }`
  }

  capacity(capacity: Capacity | undefined): string {
    if (!capacity) {
      return '<p class="quiet">The server does not tell what its machines have.</p>'
    }
    const resources = (value: Resources | undefined) =>
      value ? `${formatCpu(value.cpu)} CPU · ${formatMemory(value.memory)}` : '<span class="quiet">?</span>'
    const owner = (group: CapacityGroup) =>
      group.owner
        ? `${owns(this.viewer, { owner: group.owner } as Run) ? 'yours' : h(group.owner.sub)}${
            group.run ? ` · <a href="/runs/${h(group.run)}">${h(group.run)}</a>` : ''
          }`
        : '<span class="quiet">no run the server keeps</span>'
    const groups =
      capacity.groups.length > 0
        ? `<section><h2>Namespaces <small>${
            capacity.groups.length
          }</small></h2><table><thead><tr><th>Namespace</th><th>Whose</th><th class="num">Pods</th><th>Requested</th><th>Quota</th><th>In use</th></tr></thead><tbody>${capacity.groups
            .map(
              (group) =>
                `<tr><td><code>${h(group.name)}</code><br><small class="quiet">${
                  group.kind === 'service-run' ? 'a service run' : 'runs of a caller'
                }</small></td><td>${owner(group)}</td><td class="num" data-label="Pods">${
                  group.pods
                }</td><td data-label="Requested">${resources(group.requested)}${
                  group.quota ? bar(group.requested.cpu, group.quota.cpu) : ''
                }</td><td data-label="Quota">${
                  group.quota ? resources(group.quota) : '<span class="quiet">none</span>'
                }</td><td data-label="In use">${resources(group.used)}</td></tr>`
            )
            .join('')}</tbody></table></section>`
        : ''
    const problems =
      capacity.problems.length > 0
        ? `<section><h2>Not shown</h2><ul>${capacity.problems.map((p) => `<li>${h(p)}</li>`).join('')}</ul></section>`
        : ''
    return `<p class="quiet">${capacity.backend === 'kubernetes' ? 'On Kubernetes' : 'On a host'}, read ${this.time(
      capacity.at
    )}. Requested is what the pods of runs asked the scheduler for; in use is what they use now.</p><div class="meters">${this.capacityMeters(
      capacity
    )}<div class="meter"><strong>Runs</strong><small>${
      capacity.runs.pods !== undefined ? `${capacity.runs.pods} pods · ` : ''
    }${capacity.runs.containers !== undefined ? `${capacity.runs.containers} containers · ` : ''}requested ${resources(
      capacity.runs.requested
    )}${capacity.runs.used ? ` · in use ${resources(capacity.runs.used)}` : ''}</small></div></div>${groups}${problems}`
  }

  // ---- parts ----

  private actions(run: ListedRun, compact: boolean): string {
    const { grant } = this.viewer
    const fullRun = this.context.registry.peek(run.id)
    if (!fullRun || isFinal(fullRun.state)) {
      return ''
    }
    const owner = owns(this.viewer, fullRun)
    const mayStop = owner || decides(this.viewer, fullRun)
    const mayExtend =
      !!fullRun.up && !!fullRun.upAt && (owner || mayOpenEndpoints(grant, fullRun)) && fullRun.state !== 'queued'
    const back = compact ? '/services' : `/runs/${run.id}`
    const hidden = `<input type="hidden" name="csrf" value="${h(
      this.csrf
    )}"><input type="hidden" name="back" value="${h(back)}">`
    const parts: string[] = []
    if (mayExtend) {
      parts.push(
        `<form method="post" action="/runs/${h(
          run.id
        )}/extend">${hidden}<select name="ttl" aria-label="Keep it for">${EXTEND_CHOICES.map(
          (ttl) => `<option value="${ttl}"${ttl === '8h' ? ' selected' : ''}>${ttl}</option>`
        ).join('')}</select><button>Extend</button></form>`
      )
    }
    if (mayStop) {
      parts.push(
        `<form method="post" action="/runs/${h(run.id)}/stop">${hidden}<button class="danger">Stop</button></form>`
      )
    }
    return parts.length > 0 ? `<div class="actions">${parts.join('')}</div>` : ''
  }

  private work(run: Pick<ListedRun, 'tasks' | 'up'>): string {
    if (run.up) {
      return `<code>${h(run.up.name)}</code>: up ${h(run.up.services.join(', '))}`
    }
    return run.tasks.length > 0 ? h(run.tasks.join(', ')) : '<span class="quiet">by labels</span>'
  }

  private ownerOf(run: ListedRun): string {
    return run.owner ? ` <small class="owner">of ${h(run.owner.sub)}</small>` : ''
  }

  private source(run: Pick<Run, 'source'>): string {
    const source = run.source
    if (source.type === 'ref') {
      return `${h(source.repo)}<br><small><code>${h(source.ref)}</code> at <code>${h(
        source.commit.slice(0, 12)
      )}</code></small>`
    }
    if (source.type === 'sandbox') {
      return `sandbox <code>${h(source.id)}</code><br><small>${h(source.repo)} at <code>${h(
        source.commit.slice(0, 12)
      )}</code>${source.clean === false ? ' with changes' : ''}</small>`
    }
    return 'an upload'
  }

  private state(state: string): string {
    return `<span class="state ${h(state)}">${h(state)}</span>`
  }

  // a time as how long ago or until, with the time itself on hover
  private time(iso: string | undefined): string {
    const at = Date.parse(iso ?? '')
    if (!Number.isFinite(at)) {
      return ''
    }
    const diff = at - this.now
    const text = roughly(Math.abs(diff))
    return `<time datetime="${h(iso as string)}" title="${h(iso as string)}">${
      Math.abs(diff) < 1000 ? 'now' : diff > 0 ? `in ${h(text)}` : `${h(text)} ago`
    }</time>`
  }
}

// what each task and service of a plan does, never a secret's value
function planEntries(plan: Record<string, TaskPlan>): string {
  return Object.entries(plan)
    .map(
      ([name, entry]) =>
        `<div class="plan"><strong><code>${h(name)}</code></strong> <small class="quiet">${h(entry.kind)}, ${h(
          entry.runtime
        )}${entry.image ? ` <code>${h(entry.image)}</code>` : ''}</small>${
          entry.flags.length > 0 ? ` <span class="flag">${h(entry.flags.join(', '))}</span>` : ''
        }${entry.description ? `<br><small>${h(entry.description)}</small>` : ''}${
          entry.cmds.length > 0 ? `<pre class="log">${entry.cmds.map((cmd) => `$ ${h(cmd)}`).join('\n')}</pre>` : ''
        }<small>${[
          entry.deps.length > 0 ? `after ${h(entry.deps.join(', '))}` : '',
          entry.needs.length > 0 ? `needs ${h(entry.needs.join(', '))}` : '',
          ...entry.secrets.map(
            (secret) =>
              `secret ${h(secret.from)}${secret.account ? ` as <code>${h(secret.account)}</code>` : ''} → ${h(
                secret.target
              )}`
          ),
          entry.mounts.length > 0 ? `mounts ${h(entry.mounts.join(', '))}` : '',
          entry.ports.length > 0 ? `ports ${h(entry.ports.join(', '))}` : '',
          entry.capAdd?.length ? `capAdd ${h(entry.capAdd.join(', '))}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}</small></div>`
    )
    .join('')
}

function matchesText(run: Run, text: string): boolean {
  const needle = text.toLowerCase()
  const haystack = [
    run.id,
    run.owner.sub,
    ...run.tasks,
    ...(run.up ? [run.up.name, ...run.up.services] : []),
    run.source.type === 'upload' ? '' : run.source.repo,
    run.source.type === 'ref' ? run.source.ref : '',
  ]
  return haystack.some((value) => value.toLowerCase().includes(needle))
}

async function readText(req: IncomingMessage, limit: number): Promise<string> {
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString('utf8')
    if (text.length > limit) {
      break
    }
  }
  return text.slice(0, limit)
}

export { h }
