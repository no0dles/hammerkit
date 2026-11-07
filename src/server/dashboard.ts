import { IncomingMessage, ServerResponse } from 'http'
import type { Principal } from './oauth'
import { canUse, getGrant } from './policy'
import {
  describeWait,
  filterRuns,
  getOverview,
  ListedRun,
  Meter,
  maySee,
  Overview,
  toListedRun,
  Viewer,
  VisibleWaitReason,
} from './overview'
import { isFinal, Run, RunRegistry, RunState, TaskResult } from './runs'
import type { ServerConfig } from './server-config'
import { mayOpenEndpoints } from './service-runs'
import { readLogs, LogLine } from './run-logs'
import { formatDuration, parseDuration } from '../utils/units'

/**
 * The dashboard: pages of the server's own that show a person what `remote status`,
 * `remote services`, `remote runs` and `remote logs` print, with the same rules of who sees
 * what (overview.ts). The pages are plain HTML, without a script: a page that changes reloads
 * itself with a `refresh` header. Text of runs (task names, log lines, errors) comes from
 * whoever wrote the build file and is always escaped.
 */
export interface DashboardContext {
  config: ServerConfig
  registry: RunRegistry
  // signs the token of the forms, with the key of the sessions
  sign: (value: string) => string
  log: (line: string) => void
  now?: () => number
}

const REFRESH_SECONDS = 10
const LOG_LINES = 200
const EXTEND_CHOICES = ['1h', '8h', '24h', '72h']
const ACTIVE: RunState[] = ['awaiting-approval', 'queued', 'running', 'up', 'asleep']

export async function handleDashboard(
  context: DashboardContext,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const now = context.now ?? Date.now
  const grant = getGrant(context.config.entitlements, principal)
  const viewer: Viewer = { principal, grant }
  const page = new Page(context, viewer, now())
  if (grant.matched.length === 0) {
    return page.send(res, 403, 'Not allowed', '<p>You are not entitled to anything on this server.</p>')
  }
  const path = url.pathname
  const action = /^\/runs\/(run_[A-Za-z0-9_-]{16})\/(stop|extend)$/.exec(path)
  if (action) {
    if (req.method !== 'POST') {
      return page.send(res, 405, 'Not allowed', '<p>Use the buttons of the run’s page.</p>')
    }
    const form = new URLSearchParams(await readText(req, 4096))
    if (!page.validCsrf(form.get('csrf'))) {
      return page.send(res, 403, 'Not allowed', '<p>The form is out of date, open the page again.</p>')
    }
    const [, id, verb] = action
    const back = ownBack(form.get('back'), `/runs/${id}`)
    if (verb === 'stop') {
      const run = context.registry.cancel(principal, id, (account) => canUse(grant, account))
      context.log(`dashboard stop iss=${principal.iss} sub=${principal.sub} run=${id} found=${Boolean(run)}`)
      if (!run) {
        return page.send(res, 404, 'Not found', '<p>There is no such run you may stop.</p>')
      }
    } else {
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
    }
    res.writeHead(303, { location: back, 'cache-control': 'no-store' })
    res.end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return page.send(res, 405, 'Not allowed', '<p>This page is only read.</p>')
  }
  if (path === '/') {
    const overview = getOverview(context.registry.snapshot(), context.registry.usage(principal), viewer)
    return page.send(res, 200, 'Overview', page.overview(overview), { refresh: true, nav: 'overview' })
  }
  if (path === '/services') {
    const runs = filterRuns(context.registry.all(), viewer, { scope: 'visible', kind: 'services' })
    return page.send(res, 200, 'Service runs', page.services(runs), { refresh: true, nav: 'services' })
  }
  if (path === '/runs') {
    return page.send(res, 200, 'Runs', page.runs(url.searchParams), { nav: 'runs' })
  }
  const one = /^\/runs\/(run_[A-Za-z0-9_-]{16})$/.exec(path)
  if (one) {
    const run = context.registry.peek(one[1])
    if (!run || !maySee(viewer, run)) {
      return page.send(res, 404, 'Not found', '<p>There is no such run you may see.</p>', { nav: 'runs' })
    }
    return page.send(res, 200, run.id, page.run(run, url.searchParams), {
      refresh: !isFinal(run.state),
      nav: 'runs',
    })
  }
  return page.send(res, 404, 'Not found', '<p>There is no such page.</p>')
}

// A path of the dashboard a form goes back to, never another host.
function ownBack(value: string | null, fallback: string): string {
  return value && /^\/[A-Za-z0-9_\-/?=&.,]*$/.test(value) && !value.startsWith('//') ? value : fallback
}

class Page {
  constructor(
    private readonly context: DashboardContext,
    private readonly viewer: Viewer,
    private readonly now: number
  ) {}

  private get csrf(): string {
    return this.context.sign(`dashboard\0csrf\0${this.viewer.principal.iss}\0${this.viewer.principal.sub}`)
  }

  validCsrf(value: string | null): boolean {
    return value !== null && value.length === this.csrf.length && value === this.csrf
  }

  send(
    res: ServerResponse,
    status: number,
    title: string,
    body: string,
    options: { refresh?: boolean; nav?: 'overview' | 'services' | 'runs' } = {}
  ): void {
    const link = (href: string, name: string, key: string) =>
      `<a href="${href}"${options.nav === key ? ' aria-current="page"' : ''}>${name}</a>`
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...(options.refresh ? { refresh: String(REFRESH_SECONDS) } : {}),
    })
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(
        title
      )} · hammerkit</title><style>${STYLE}</style></head><body><header><strong>hammerkit</strong><nav>${link(
        '/',
        'Overview',
        'overview'
      )}${link('/services', 'Service runs', 'services')}${link('/runs', 'Runs', 'runs')}</nav><span class="who">${h(
        this.viewer.principal.sub
      )}${
        this.viewer.grant.observe ? ' · observes' : ''
      } · <a href="/.hammerkit/logout">Sign out</a></span></header><main><h1>${h(
        title
      )}</h1>${body}</main></body></html>`
    )
  }

  // ---- overview ----

  overview(overview: Overview): string {
    const { places } = overview
    const slots = [
      ...places.runs.map(
        (run) =>
          `<li class="slot${run.owner ? '' : ' mine'}"><a href="/runs/${h(run.id)}">${h(run.id)}</a><span>${this.work(
            run
          )}${this.ownerOf(run)}</span><small>${run.startedAt ? `since ${this.time(run.startedAt)}` : ''}</small></li>`
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
                }</span><small>waits: ${h(describeWait(entry.waitsFor, entry.mine, false))}</small></li>`
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
<section><h2>Your limits <small>and the runs that count against them</small></h2><div class="meters">${[
      this.meter('Running', overview.limits.running, 'runs.limits.running'),
      this.meter('Queued', overview.limits.queued, 'runs.limits.queued'),
      this.meter('Waiting for approval', overview.limits.waiting, 'runs.limits.waiting'),
      this.meter('Service runs', overview.limits.services, 'runs.up.limits.up'),
    ].join('')}</div></section>
<section><h2>Waiting for an approval <small>${overview.approvals.waiting} of at most ${
      overview.approvals.max
    } on the server</small></h2>${approvals || '<p class="quiet">None you decide about or asked for.</p>'}</section>
<section><h2>Service runs <small>${overview.services.open}${
      overview.services.max !== undefined ? ` of ${overview.services.max}` : ''
    } on the server</small></h2>${
      overview.services.runs.length > 0
        ? this.serviceTable(overview.services.runs)
        : '<p class="quiet">None you may see is starting, up or asleep.</p>'
    }</section>`
  }

  private meter(name: string, meter: Meter, key: string): string {
    const share = meter.limit ? Math.min(100, Math.round((meter.used / meter.limit) * 100)) : 0
    const full = meter.limit !== undefined && meter.used >= meter.limit
    return `<div class="meter${full ? ' full' : ''}"><strong>${h(name)} ${meter.used}${
      meter.limit !== undefined ? ` of ${meter.limit}` : ''
    }</strong><div class="bar"><div style="width:${share}%"></div></div><small>${
      meter.runs.length > 0 ? meter.runs.map((id) => `<a href="/runs/${h(id)}">${h(id)}</a>`).join(', ') : 'none'
    }</small><small class="quiet">${h(key)}</small></div>`
  }

  // ---- service runs ----

  services(runs: Run[]): string {
    const day = 24 * 60 * 60 * 1000
    const groups: [string, Run[]][] = [
      ['Up', runs.filter((run) => run.state === 'up')],
      ['Asleep', runs.filter((run) => run.state === 'asleep')],
      ['Starting', runs.filter((run) => ['awaiting-approval', 'queued', 'running'].includes(run.state))],
      [
        'Ended in the last day',
        runs.filter((run) => isFinal(run.state) && this.now - Date.parse(run.finishedAt ?? run.createdAt) < day),
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
          .map(
            (endpoint) => `<a href="${h(endpoint.url)}" rel="noreferrer">${h(endpoint.service)}:${endpoint.port}</a>`
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

  runs(params: URLSearchParams): string {
    const all = params.get('all') === '1'
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
    const form = `<form method="get" class="filter"><select name="state" aria-label="State">${option(
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
    )}" placeholder="task, service, ref, id" aria-label="Search"><label><input type="checkbox" name="all" value="1"${
      all ? ' checked' : ''
    }> others I may see</label><button>Show</button></form>`
    if (runs.length === 0) {
      return `${form}<p class="quiet">No runs the server keeps are like that.</p>`
    }
    return `${form}<table><thead><tr><th>Run</th><th>State</th><th>What</th><th>Source</th><th>Created</th><th>Took</th></tr></thead><tbody>${runs
      .map((run) => {
        const listed = toListedRun(this.viewer, run)
        const queue = run.state === 'queued' ? this.context.registry.queued(run.id) : undefined
        return `<tr><td><a href="/runs/${h(run.id)}">${h(run.id)}</a>${this.ownerOf(listed)}</td><td>${this.state(
          run.state
        )}${queue ? `<br><small>${queue.position}. in the queue</small>` : ''}</td><td>${this.work(listed)}${
          run.error ? `<br><small class="error">${h(cut(run.error, 200))}</small>` : ''
        }</td><td>${this.source(run)}</td><td data-label="Created">${this.time(
          run.createdAt
        )}</td><td data-label="Took">${this.took(run)}</td></tr>`
      })
      .join('')}</tbody></table>`
  }

  run(run: Run, params: URLSearchParams): string {
    const { principal, grant } = this.viewer
    const owner = run.owner.iss === principal.iss && run.owner.sub === principal.sub
    // the results and the log are for its owner and who decides about it, as GET /v1/runs/<id>
    const full = owner || (run.approvals ?? []).some((approval) => canUse(grant, approval.account))
    const queue = run.state === 'queued' ? this.context.registry.queued(run.id) : undefined
    const facts: [string, string][] = [
      ['State', `${this.state(run.state)}${run.error ? ` <span class="error">${h(cut(run.error, 2000))}</span>` : ''}`],
      ...(owner
        ? []
        : ([['Owner', `<code>${h(run.owner.sub)}</code> <small class="quiet">${h(run.owner.iss)}</small>`]] as [
            string,
            string,
          ][])),
      ['What', this.work(toListedRun(this.viewer, run))],
      ['Source', this.source(run)],
      ['Build file', `<code>${h(run.definition)}</code>`],
      ...(run.accounts.length > 0
        ? ([['Accounts', run.accounts.map((a) => `<code>${h(a)}</code>`).join(', ')]] as [string, string][])
        : []),
      ['Created', this.time(run.createdAt)],
      ...(run.startedAt ? ([['Started', this.time(run.startedAt)]] as [string, string][]) : []),
      ...(run.finishedAt
        ? ([['Finished', `${this.time(run.finishedAt)} · took ${this.took(run)}`]] as [string, string][])
        : []),
    ]
    if (queue) {
      const visible = (id: string) => {
        const holder = this.context.registry.peek(id)
        return !!holder && maySee(this.viewer, holder)
      }
      const reason = queue.waitsFor
      const shown: VisibleWaitReason =
        (reason.type === 'sandbox' || reason.type === 'held') && !visible(reason.run) ? { type: reason.type } : reason
      facts.push(['Queue', `${queue.position}. waits: ${h(describeWait(shown, owner, false))}`])
    }
    for (const approval of run.approvals ?? []) {
      facts.push([
        `Approval of <code>${h(approval.account)}</code>`,
        approval.approvedBy
          ? `approved by <code>${h(approval.approvedBy.sub)}</code>`
          : `waits until ${this.time(approval.expiresAt)}`,
      ])
    }
    if (run.up) {
      facts.push(
        ['Services', h(run.up.services.join(', '))],
        [
          'Endpoints',
          run.up.endpoints.map((e) => `<a href="${h(e.url)}" rel="noreferrer">${h(e.url)}</a>`).join('<br>') ||
            '<span class="quiet">none</span>',
        ]
      )
      if (run.upAt) {
        facts.push(['Up since', this.time(run.upAt)])
      }
      if (run.expiresAt) {
        facts.push(['Ends', this.time(run.expiresAt)])
      }
      if (run.up.sleepTtl) {
        facts.push([
          'Sleeps',
          `after ${h(formatDuration(run.up.sleepTtl))} without a request${
            run.state === 'up' && run.sleepsAt ? `, next at ${this.time(run.sleepsAt)}` : ''
          }${run.wakes ? `, woken ${run.wakes}×` : ''}`,
        ])
      }
    }
    const summary = `<dl class="facts">${facts
      .map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`)
      .join('')}</dl>${this.actions(toListedRun(this.viewer, run), false)}`
    if (!full) {
      return `${summary}<p class="quiet">The tasks and the log of this run are for its owner and who decides about it.</p>`
    }
    return `${summary}${this.results(run)}${this.logs(run, params)}`
  }

  private results(run: Run): string {
    const results = Object.entries(run.results ?? {})
    if (results.length === 0) {
      return ''
    }
    return `<section><h2>Tasks</h2><table><thead><tr><th>Task</th><th>Status</th><th>Took</th><th>Cache</th><th>Exit</th></tr></thead><tbody>${results
      .map(
        ([task, result]: [string, TaskResult]) =>
          `<tr><td><a href="?task=${encodeURIComponent(task)}#log">${h(task)}</a></td><td>${this.state(result.status)}${
            result.error ? `<br><small class="error">${h(cut(result.error, 500))}</small>` : ''
          }</td><td data-label="Took">${
            result.durationMs !== undefined ? h(formatDuration(result.durationMs)) : ''
          }</td><td data-label="Cache">${
            result.cache?.hit
              ? 'hit'
              : result.cache?.causes?.length
                ? `<small>${result.cache.causes.map((cause) => h(cut(cause, 200))).join('<br>')}</small>`
                : ''
          }</td><td data-label="Exit">${result.exitCode ?? ''}</td></tr>`
      )
      .join('')}</tbody></table></section>`
  }

  private logs(run: Run, params: URLSearchParams): string {
    const { principal, grant } = this.viewer
    const logs = this.context.registry.logs(principal, run.id, (account) => canUse(grant, account))
    if (!logs) {
      return ''
    }
    const tasks = Object.keys(run.results ?? {})
    const task = params.get('task') ?? undefined
    const chosen = task !== undefined && (tasks.includes(task) || task === 'hammerkit') ? task : undefined
    const page = readLogs(
      logs.events,
      logs.index,
      { ...(chosen ? { task: chosen } : {}), tail: LOG_LINES, limit: LOG_LINES, ignoreCase: false, context: 0 },
      logs.truncated
    )
    const filter = `<nav class="tasks"><a href="/runs/${h(run.id)}#log"${
      chosen ? '' : ' aria-current="page"'
    }>all</a>${tasks
      .map(
        (name) =>
          `<a href="?task=${encodeURIComponent(name)}#log"${name === chosen ? ' aria-current="page"' : ''}>${h(
            name
          )}</a>`
      )
      .join('')}</nav>`
    const lines = page.lines
      .map(
        (line: LogLine) =>
          `<span class="${line.stream}">${chosen ? '' : `<b>[${h(line.task)}]</b> `}${h(
            printableLine(line.text)
          )}</span>`
      )
      .join('\n')
    return `<section id="log"><h2>Log <small>the last ${Math.min(LOG_LINES, page.total)} of ${page.total} lines${
      page.truncated ? ', cut off at runs.maxLogBytes' : ''
    }</small></h2>${filter}<pre class="log">${
      lines || '<span class="quiet">nothing yet</span>'
    }</pre><p class="quiet">All of it: <code>hammerkit remote logs ${h(run.id)}</code></p></section>`
  }

  // ---- parts ----

  private actions(run: ListedRun, compact: boolean): string {
    const { principal, grant } = this.viewer
    const fullRun = this.context.registry.peek(run.id)
    if (!fullRun || isFinal(fullRun.state)) {
      return ''
    }
    const owner = fullRun.owner.iss === principal.iss && fullRun.owner.sub === principal.sub
    const mayStop = owner || (fullRun.approvals ?? []).some((approval) => canUse(grant, approval.account))
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

  private took(run: Run): string {
    const start = Date.parse(run.startedAt ?? '')
    const end = Date.parse(run.finishedAt ?? '') || this.now
    const took = Math.max(0, end - start)
    return Number.isFinite(start) ? h(took < 1000 ? `${took}ms` : roughly(took)) : ''
  }

  // a time as how long ago or until, with the time itself on hover
  private time(iso: string | undefined): string {
    const at = Date.parse(iso ?? '')
    if (!Number.isFinite(at)) {
      return ''
    }
    const diff = at - this.now
    const span = roughly(Math.abs(diff))
    return `<time datetime="${h(iso as string)}" title="${h(iso as string)}">${
      Math.abs(diff) < 1000 ? 'now' : diff > 0 ? `in ${h(span)}` : `${h(span)} ago`
    }</time>`
  }
}

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

function matchesText(run: Run, text: string): boolean {
  const needle = text.toLowerCase()
  const haystack = [
    run.id,
    ...run.tasks,
    ...(run.up ? [run.up.name, ...run.up.services] : []),
    run.source.type === 'upload' ? '' : run.source.repo,
    run.source.type === 'ref' ? run.source.ref : '',
  ]
  return haystack.some((value) => value.toLowerCase().includes(needle))
}

// a span of time as a person reads it at a glance: 7h 59m, 29m, 12s
function roughly(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  const [d, h, m] = [Math.floor(seconds / 86400), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60]
  if (d > 0) {
    return `${d}d ${h}h`
  }
  if (h > 0) {
    return `${h}h ${m}m`
  }
  return m > 0 ? `${m}m` : `${seconds}s`
}

function cut(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

// control characters and the marks that turn text around, of a log line: shown, not obeyed
function printableLine(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0
      const control = (code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f)
      const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
      return control || bidi ? '?' : char
    })
    .join('')
}

export function h(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
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

const STYLE = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--quiet:#78716c;--line:#e7e5e4;--box:#fff;--accent:#2563eb;--tint:#eff6ff;--warn:#d97706;--bad:#dc2626;--good:#16a34a}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--quiet:#a8a29e;--line:#44403c;--box:#292524;--accent:#60a5fa;--tint:#1e3a5f;--warn:#fbbf24;--bad:#f87171;--good:#4ade80}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap;padding:.75rem 1rem;border-bottom:1px solid var(--line);background:var(--box)}
header nav{display:flex;gap:1rem;flex:1}header nav a{color:var(--fg);text-decoration:none;padding:.25rem 0}header nav a[aria-current]{border-bottom:2px solid var(--accent)}
.who{color:var(--quiet);font-size:.875rem}a{color:var(--accent)}main{max-width:72rem;margin:0 auto;padding:1rem}
h1{font-size:1.5rem;margin:.5rem 0 1rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}h2 small,.quiet{color:var(--quiet);font-weight:400}
code{font-family:ui-monospace,monospace;font-size:.9em}small{font-size:.8rem}
.slots{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:.75rem}
.slot{border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;background:var(--box);display:flex;flex-direction:column;min-height:4.5rem}
.slot.mine{border:2px solid var(--accent);background:var(--tint)}.slot.other{color:var(--quiet)}.slot.free{border-style:dashed;color:var(--quiet);background:transparent}.slot.warn{border-color:var(--warn);color:var(--warn)}
.queue{padding:0;margin:0;list-style:none;counter-reset:q}.queue li{counter-increment:q;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;padding:.5rem .8rem;margin-bottom:.5rem;background:var(--box)}
.queue li::before{content:counter(q) ".";color:var(--quiet);margin-right:.5rem}.queue li span{flex:1}.queue li.mine{background:var(--tint)}.queue li small{color:var(--quiet)}
.meters{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.75rem}.meter{border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;background:var(--box);display:flex;flex-direction:column;gap:.3rem}
.bar{height:8px;border-radius:4px;background:var(--line)}.bar div{height:8px;border-radius:4px;background:var(--accent)}.meter.full .bar div{background:var(--warn)}.meter.full strong{color:var(--warn)}
table{width:100%;border-collapse:collapse;background:var(--box);border:1px solid var(--line);border-radius:8px}th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;color:var(--quiet);font-weight:600}
.state{font-size:.8rem;padding:.05rem .45rem;border-radius:999px;border:1px solid var(--line);white-space:nowrap}.state.up,.state.succeeded,.state.cached{color:var(--good);border-color:var(--good)}.state.failed,.state.rejected{color:var(--bad);border-color:var(--bad)}.state.running,.state.queued{color:var(--accent);border-color:var(--accent)}.state.asleep,.state.awaiting-approval{color:var(--warn);border-color:var(--warn)}
.error{color:var(--bad)}.owner{color:var(--quiet)}.facts{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1rem;margin:0 0 1rem}.facts dt{color:var(--quiet)}.facts dd{margin:0}
.actions{display:flex;gap:.5rem;flex-wrap:wrap}.actions form{display:flex;gap:.25rem}button,select,input{font:inherit;padding:.25rem .5rem;border-radius:6px;border:1px solid var(--line);background:var(--box);color:var(--fg)}button{cursor:pointer}button.danger{color:var(--bad);border-color:var(--bad)}
.filter{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}.tasks{display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:.5rem}.tasks a[aria-current]{font-weight:600;text-decoration:none;color:var(--fg)}
.log{background:#0c0a09;color:#e7e5e4;padding:.75rem;border-radius:8px;overflow-x:auto;font-size:.8rem;line-height:1.45}.log .stderr{color:#fca5a5}.log b{color:#a8a29e;font-weight:400}
@media (max-width:40rem){table,thead,tbody,tr,td{display:block}thead{display:none}td{border:0;padding:.2rem .6rem}td[data-label]::before{content:attr(data-label) ": ";color:var(--quiet);font-size:.8rem}tr{border-bottom:1px solid var(--line);padding:.4rem 0}}
`
