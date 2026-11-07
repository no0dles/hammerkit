import { ServerResponse } from 'http'
import { roughly } from './timings'

/**
 * The parts of the dashboard's pages that are only HTML: escaping, the layout and the style.
 * Every text of a run, a build file or a person goes through `h()`.
 */

// control characters and the marks that turn text around: shown, not obeyed
function isHidden(code: number): boolean {
  const control = (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
  const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  return control || bidi
}

// A text as it is to be read: control characters and bidi marks become `?`. Line breaks (also
// CRLF) stay
// in an error; a line of a log has none.
export function printable(text: string): string {
  let out = ''
  // a file written on Windows: its line ends are line ends
  for (const char of text.replace(/\r\n/g, '\n')) {
    out += isHidden(char.codePointAt(0) ?? 0) ? '?' : char
  }
  return out
}

// A log line: also its line breaks (there are none) and tabs stay.
export function printableLine(text: string): string {
  return printable(text).replace(/\n/g, '?')
}

// Escaped for HTML text and attribute values, made printable.
export function h(text: string): string {
  return printable(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

export function cut(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

// a span in ms, or nothing
export function span(ms: number | undefined): string {
  return ms === undefined ? '' : h(roughly(ms))
}

export type Nav = 'overview' | 'services' | 'runs' | 'tasks' | 'approvals' | 'capacity'

export interface Layout {
  status: number
  title: string
  body: string
  refresh?: number
  nav?: Nav
  who: string
  // how many approvals wait for the viewer, shown on the nav
  waiting?: number
}

const NAV: [string, string, Nav][] = [
  ['/', 'Overview', 'overview'],
  ['/services', 'Service runs', 'services'],
  ['/runs', 'Runs', 'runs'],
  ['/tasks', 'Tasks', 'tasks'],
  ['/approvals', 'Approvals', 'approvals'],
  ['/capacity', 'Capacity', 'capacity'],
]

export const HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

export function sendPage(res: ServerResponse, layout: Layout): void {
  res.writeHead(layout.status, {
    'content-type': 'text/html; charset=utf-8',
    ...HEADERS,
    ...(layout.refresh ? { refresh: String(layout.refresh) } : {}),
  })
  const nav = NAV.map(
    ([href, name, key]) =>
      `<a href="${href}"${layout.nav === key ? ' aria-current="page"' : ''}>${name}${
        key === 'approvals' && layout.waiting ? ` <span class="badge">${layout.waiting}</span>` : ''
      }</a>`
  ).join('')
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(
      layout.title
    )} · hammerkit</title><style>${STYLE}</style></head><body><header><strong>hammerkit</strong><nav>${nav}</nav><span class="who">${
      layout.who
    } · <a href="/.hammerkit/logout">Sign out</a></span></header><main><h1>${h(layout.title)}</h1>${
      layout.body
    }</main></body></html>`
  )
}

// a bar of how much of something is taken: `used` of `max`, with a second mark for `also`
export function bar(used: number | undefined, max: number | undefined, also?: number): string {
  if (!max || used === undefined) {
    return '<div class="bar"></div>'
  }
  const share = (value: number) => Math.min(100, Math.round((value / max) * 100))
  return `<div class="bar">${
    also !== undefined ? `<div class="also" style="width:${share(also)}%"></div>` : ''
  }<div style="width:${share(used)}%"></div></div>`
}

export const STYLE = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--quiet:#78716c;--line:#e7e5e4;--box:#fff;--accent:#2563eb;--tint:#eff6ff;--warn:#d97706;--bad:#dc2626;--good:#16a34a}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--quiet:#a8a29e;--line:#44403c;--box:#292524;--accent:#60a5fa;--tint:#1e3a5f;--warn:#fbbf24;--bad:#f87171;--good:#4ade80}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap;padding:.75rem 1rem;border-bottom:1px solid var(--line);background:var(--box)}
header nav{display:flex;gap:1rem;flex:1;flex-wrap:wrap}header nav a{color:var(--fg);text-decoration:none;padding:.25rem 0}header nav a[aria-current]{border-bottom:2px solid var(--accent)}
.badge{background:var(--warn);color:#fff;border-radius:999px;font-size:.75rem;padding:0 .45rem}
.who{color:var(--quiet);font-size:.875rem}a{color:var(--accent)}main{max-width:76rem;margin:0 auto;padding:1rem}
h1{font-size:1.5rem;margin:.5rem 0 1rem;overflow-wrap:anywhere}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}h2 small,.quiet{color:var(--quiet);font-weight:400}h3{font-size:1rem;margin:1rem 0 .25rem}
code{font-family:ui-monospace,monospace;font-size:.9em;overflow-wrap:anywhere}small{font-size:.8rem}
.slots{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:.75rem}
.slot{border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;background:var(--box);display:flex;flex-direction:column;min-height:4.5rem}
.slot.mine{border:2px solid var(--accent);background:var(--tint)}.slot.other{color:var(--quiet)}.slot.free{border-style:dashed;color:var(--quiet);background:transparent}.slot.warn{border-color:var(--warn);color:var(--warn)}
.queue{padding:0;margin:0;list-style:none;counter-reset:q}.queue li{counter-increment:q;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;padding:.5rem .8rem;margin-bottom:.5rem;background:var(--box)}
.queue li::before{content:counter(q) ".";color:var(--quiet);margin-right:.5rem}.queue li span{flex:1}.queue li.mine{background:var(--tint)}.queue li small{color:var(--quiet)}
.meters{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.75rem}.meter{border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;background:var(--box);display:flex;flex-direction:column;gap:.3rem}
.bar{position:relative;height:8px;border-radius:4px;background:var(--line);overflow:hidden}.bar div{position:absolute;left:0;top:0;height:8px;border-radius:4px;background:var(--accent)}.bar div.also{background:var(--accent);opacity:.35}.meter.full .bar div{background:var(--warn)}.meter.full strong{color:var(--warn)}
table{width:100%;border-collapse:collapse;background:var(--box);border:1px solid var(--line);border-radius:8px}th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;color:var(--quiet);font-weight:600}td.num,th.num{text-align:right;white-space:nowrap}
.state{font-size:.8rem;padding:.05rem .45rem;border-radius:999px;border:1px solid var(--line);white-space:nowrap}.state.up,.state.succeeded,.state.cached,.state.approved{color:var(--good);border-color:var(--good)}.state.failed,.state.rejected{color:var(--bad);border-color:var(--bad)}.state.running,.state.queued{color:var(--accent);border-color:var(--accent)}.state.asleep,.state.awaiting-approval,.state.waiting{color:var(--warn);border-color:var(--warn)}
.error{color:var(--bad);white-space:pre-wrap}.owner{color:var(--quiet)}.facts{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1rem;margin:0 0 1rem}.facts dt{color:var(--quiet)}.facts dd{margin:0;overflow-wrap:anywhere}
.actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}.actions form{display:flex;gap:.25rem;flex-wrap:wrap}button,select,input{font:inherit;padding:.25rem .5rem;border-radius:6px;border:1px solid var(--line);background:var(--box);color:var(--fg)}button{cursor:pointer}button.danger{color:var(--bad);border-color:var(--bad)}button.good{color:#fff;background:var(--good);border-color:var(--good)}
.filter{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}.tasks{display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:.5rem}.tasks a[aria-current]{font-weight:600;text-decoration:none;color:var(--fg)}
.card{border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;background:var(--box);margin-bottom:.75rem}.card .facts{margin-bottom:.5rem}
.plan{margin:.25rem 0 .75rem}.plan pre,.file pre{margin:.25rem 0;white-space:pre-wrap;overflow-wrap:anywhere}.flag{color:var(--warn);font-size:.8rem}
.log,.file pre{background:#0c0a09;color:#e7e5e4;padding:.75rem;border-radius:8px;overflow-x:auto;font-size:.8rem;line-height:1.45}.log .stderr{color:#fca5a5}.log b{color:#a8a29e;font-weight:400}.log mark{background:#854d0e;color:#fff}
.pager{display:flex;gap:1rem;margin:.5rem 0}
@media (max-width:40rem){table,thead,tbody,tr,td{display:block}thead{display:none}td{border:0;padding:.2rem .6rem}td.num{text-align:left}td[data-label]::before{content:attr(data-label) ": ";color:var(--quiet);font-size:.8rem}tr{border-bottom:1px solid var(--line);padding:.4rem 0}}
`
