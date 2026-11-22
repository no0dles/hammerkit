import { RETRY_HEADER } from '../server/http'
import { formatDuration } from '../utils/units'

// How long a client waits for a server that went away, as during a restart, and how long it
// pauses between tries: from the first pause on, twice as long each time, up to the longest.
export interface ReconnectTiming {
  windowMs: number
  firstDelayMs: number
  maxDelayMs: number
}

// a restart of the server takes a few minutes while its new pod starts
export const RECONNECT_TIMING: ReconnectTiming = { windowMs: 10 * 60_000, firstDelayMs: 1_000, maxDelayMs: 15_000 }

/**
 * When a call may be sent again after it failed on the way: `always` for a read, or a call
 * that ends the same however often the server takes it; `unsent` only when the server
 * certainly did not take it: the connection was refused, or the server itself answered that
 * it took nothing (a 503 it marks with RETRY_HEADER while it shuts down).
 */
export type Repeat = 'always' | 'unsent'

// An answer, or why there was none, said as the user is told it.
export type Attempt = { response: Response } | { error: unknown; message: string }

// what a proxy or the server answers while the server is away or shuts down
const AWAY_STATUSES = [502, 503, 504]
// the call never got to the server. A connect timeout is one: the connection was never
// made, so nothing of the request was sent.
const NOT_SENT = ['ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']
// the connection broke or timed out, maybe after the server took the call
const LOST = [
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]

// The codes of the error a fetch failed with: node's fetch keeps it as the cause, with one
// error for each address it tried when a name has several.
function failureCodes(e: unknown): string[] {
  if (e instanceof Error && e.name === 'TimeoutError') {
    return ['ETIMEDOUT']
  }
  const cause = (e as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | undefined)?.cause
  const codes = cause?.errors?.length ? cause.errors.map((error) => error?.code) : [cause?.code]
  return codes.map((code) => (typeof code === 'string' ? code : ''))
}

function isAway(response: Response): boolean {
  return AWAY_STATUSES.includes(response.status)
}

function mayRepeat(attempt: Attempt, repeat: Repeat): boolean {
  if ('response' in attempt) {
    return repeat === 'always'
      ? isAway(attempt.response)
      : attempt.response.status === 503 && attempt.response.headers.get(RETRY_HEADER) === 'safe'
  }
  const codes = failureCodes(attempt.error)
  return repeat === 'always'
    ? codes.some((code) => NOT_SENT.includes(code) || LOST.includes(code))
    : codes.every((code) => NOT_SENT.includes(code))
}

// The address of a server as it is said, without a user or password it may hold.
export function showUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.username && !parsed.password) {
      return url
    }
    parsed.username = ''
    parsed.password = ''
    return url.endsWith('/') ? parsed.toString() : parsed.toString().replace(/\/$/, '')
  } catch {
    return url
  }
}

export interface ReconnectOptions {
  url: string
  timing: ReconnectTiming
  // told once that the server is away and once that it is back
  say?: (line: string) => void
  // stops waiting
  signal?: AbortSignal
  // the error a call fails with
  fail: (message: string) => Error
}

/**
 * The window of one call: every send of it, a send again after a new token included, waits
 * for the server at most the window, counted from the start of the first try that failed.
 */
export class Reconnecting {
  private deadline: number | undefined
  private delay: number
  private away = false

  constructor(private readonly options: ReconnectOptions) {
    this.delay = options.timing.firstDelayMs
  }

  // the window ran out
  get exhausted(): boolean {
    return this.deadline !== undefined && this.deadline <= Date.now()
  }

  // how long the next try may take: no longer than what is left of the window, once it started
  timeoutMs(own: number): number {
    return this.deadline === undefined ? own : Math.max(1, Math.min(own, this.deadline - Date.now()))
  }

  /**
   * Sends a call until the server answers it, as long as it may be sent again and the server
   * comes back within the window: an answer other than one of a server that is away is the
   * caller's, an error that is no sign of one fails at once.
   */
  async send(send: () => Promise<Attempt>, repeat: Repeat): Promise<Response> {
    const { url, timing, say, signal, fail } = this.options
    const shown = showUrl(url)
    for (;;) {
      const started = Date.now()
      const attempt = await send()
      if (!mayRepeat(attempt, repeat)) {
        if ('response' in attempt) {
          if (this.away && !isAway(attempt.response)) {
            this.away = false
            say?.(`${shown} is back`)
          }
          return attempt.response
        }
        throw fail(attempt.message)
      }
      const reason = 'response' in attempt ? `${shown} answered ${attempt.response.status}` : attempt.message
      if ('response' in attempt) {
        await attempt.response.body?.cancel().catch(() => undefined)
      }
      const window = formatDuration(timing.windowMs)
      this.deadline ??= started + timing.windowMs
      if (!this.away) {
        this.away = true
        say?.(`${reason}, reconnecting for up to ${window}`)
      }
      const left = this.deadline - Date.now()
      if (left <= 0) {
        throw fail(`${shown} did not come back within ${window}: ${reason}`)
      }
      if (signal?.aborted || !(await pause(Math.min(this.delay, left), signal))) {
        throw fail(reason)
      }
      this.delay = Math.min(this.delay * 2, timing.maxDelayMs)
    }
  }
}

// false when the signal ended the pause
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (waited: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      resolve(waited)
    }
    const aborted = () => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}
