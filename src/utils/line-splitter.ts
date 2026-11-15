import { StringDecoder } from 'string_decoder'

// The most of a line that is held back for its end: a longer one is passed on in parts.
export const MAX_LINE_CHARS = 64 * 1024

export interface LineSplitter {
  write(chunk: Buffer | string): void
  // passes on what is left of a last line without a line feed
  end(): void
}

/**
 * The lines of output that arrives in chunks, split where getLogs splits a chunk: at a line
 * feed, with a CR before it. A line that two chunks (or two frames of docker) split is passed
 * on whole once it ends, so the mask of the secrets of a run (SecretRegistry.redact, which
 * works per line) covers a value that was split between them. Empty lines are left out, as
 * getLogs does. A line of more than `maxChars` is passed on in parts of that length.
 */
export function lineSplitter(onLine: (line: string) => void, maxChars = MAX_LINE_CHARS): LineSplitter {
  // a character split between two chunks stays whole
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const take = (text: string) => {
    const lines = (pending + text).split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line) {
        onLine(line)
      }
    }
    while (pending.length > maxChars) {
      onLine(pending.slice(0, maxChars))
      pending = pending.slice(maxChars)
    }
  }
  let ended = false
  return {
    write(chunk) {
      if (!ended) {
        take(typeof chunk === 'string' ? chunk : decoder.write(chunk))
      }
    },
    end() {
      if (ended) {
        return
      }
      ended = true
      take(decoder.end())
      if (pending) {
        onLine(pending)
        pending = ''
      }
    },
  }
}
