import { roughly } from '../../src/server/timings'

export { roughly, waitedMs, ranMs } from '../../src/server/timings'
export { formatCpu, formatMemory, plural } from '../../src/server/capacity-format'
export { describeWait } from '../../src/server/wait-reason'
export { formatDuration } from '../../src/utils/units'

// control characters and the marks that turn text around: shown, not obeyed
function isHidden(code: number): boolean {
  const control = (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
  const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  return control || bidi
}

// A text of a run, a build file or a person as it is to be read: control characters and bidi
// marks become `?`; line breaks (also CRLF) stay. React escapes the rest.
export function printable(text: string): string {
  let out = ''
  for (const char of text.replace(/\r\n/g, '\n')) {
    out += isHidden(char.codePointAt(0) ?? 0) ? '?' : char
  }
  return out
}

// A line of a log: it has no line break of its own.
export function printableLine(text: string): string {
  return printable(text).replace(/\n/g, '?')
}

export function cut(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

// a span in ms, or nothing
export function span(ms: number | undefined): string {
  return ms === undefined ? '' : roughly(ms)
}

// how long ago or until a time is
export function relative(iso: string | undefined, now: number): string {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) {
    return ''
  }
  const diff = at - now
  if (Math.abs(diff) < 1000) {
    return 'now'
  }
  const text = roughly(Math.abs(diff))
  return diff > 0 ? `in ${text}` : `${text} ago`
}
