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
 * certainly did not take it: the connection was refused, or the server answered 503.
 */
export type Repeat = 'always' | 'unsent'

// what a proxy or the server answers while the server is away or shuts down
const AWAY_STATUSES = [502, 503, 504]
// the call never got to the server
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

// The code of the error a fetch failed with: node's fetch keeps it as the cause, and one
// for each address it tried when a name has several.
function failureCode(e: unknown): string | undefined {
  if (e instanceof Error && e.name === 'TimeoutError') {
    return 'ETIMEDOUT'
  }
  const cause = (e as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | undefined)?.cause
  const code = cause?.code ?? cause?.errors?.[0]?.code
  return typeof code === 'string' ? code : undefined
}

function mayRepeat(attempt: Attempt, repeat: Repeat): boolean {
  if ('response' in attempt) {
    return attempt.response.status === 503 || (repeat === 'always' && AWAY_STATUSES.includes(attempt.response.status))
  }
  const code = failureCode(attempt.error)
  return !!code && (NOT_SENT.includes(code) || (repeat === 'always' && LOST.includes(code)))
}

export function describeWindow(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} ${ms === 60_000 ? 'minute' : 'minutes'}` : formatDuration(ms)
}

// An answer, or why there was none, said as the user is told it.
export type Attempt = { response: Response } | { error: unknown; message: string }

export interface ReconnectOptions {
  url: string
  repeat: Repeat
  timing: ReconnectTiming
  // told once that the server is away and once that it is back
  say?: (line: string) => void
  // stops waiting
  signal?: AbortSignal
  // the error a call fails with
  fail: (message: string) => Error
}

/**
 * Sends a call until the server answers it, as long as it may be sent again and the server
 * comes back within the window: an answer other than one of a server that is away is the
 * caller's, an error that is no sign of one fails at once.
 */
export async function sendReconnecting(send: () => Promise<Attempt>, options: ReconnectOptions): Promise<Response> {
  let deadline: number | undefined
  let delay = options.timing.firstDelayMs
  for (;;) {
    const attempt = await send()
    if (!mayRepeat(attempt, options.repeat)) {
      if ('response' in attempt) {
        if (deadline !== undefined) {
          options.say?.(`${options.url} is back`)
        }
        return attempt.response
      }
      throw options.fail(attempt.message)
    }
    const reason = 'response' in attempt ? `${options.url} answered ${attempt.response.status}` : attempt.message
    if ('response' in attempt) {
      await attempt.response.body?.cancel().catch(() => undefined)
    }
    const window = describeWindow(options.timing.windowMs)
    if (deadline === undefined) {
      deadline = Date.now() + options.timing.windowMs
      options.say?.(`${reason}, reconnecting for up to ${window}`)
    }
    const left = deadline - Date.now()
    if (left <= 0) {
      throw options.fail(`${options.url} did not come back within ${window}: ${reason}`)
    }
    if (options.signal?.aborted || !(await pause(Math.min(delay, left), options.signal))) {
      throw options.fail(reason)
    }
    delay = Math.min(delay * 2, options.timing.maxDelayMs)
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
