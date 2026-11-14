import { Readable } from 'stream'
import { StringDecoder } from 'string_decoder'

/**
 * Calls `onLine` with each line of `input` (without its line feed or a CR before it), as
 * readline does, but holds at most `maxChars` of a line: a longer line is cut there and
 * says so, the rest of it up to the next line feed is passed over.
 */
export function readLines(input: Readable, maxChars: number, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let cut = false
  const emit = () => {
    const line = !cut && pending.endsWith('\r') ? pending.slice(0, -1) : pending
    onLine(cut ? `${line} … [cut at ${maxChars} characters]` : line)
    pending = ''
    cut = false
  }
  const take = (text: string) => {
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      if (!cut) {
        pending += text.slice(start, newline < 0 ? undefined : newline)
        if (pending.length > maxChars) {
          pending = pending.slice(0, maxChars)
          cut = true
        }
      }
      if (newline < 0) {
        return
      }
      emit()
      start = newline + 1
    }
  }
  input.on('data', (chunk: Buffer | string) => take(typeof chunk === 'string' ? chunk : decoder.write(chunk)))
  input.on('end', () => {
    take(decoder.end())
    if (pending.length > 0 || cut) {
      emit()
    }
  })
}
