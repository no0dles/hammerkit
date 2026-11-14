import { Readable } from 'stream'
import { StringDecoder } from 'string_decoder'

/**
 * Calls `onLine` with each line of `input` as readline does: a line ends at a line feed, a CR
 * or both. It holds at most `maxChars` of a line: a longer line is cut there and says so, the
 * rest of it up to the end of the line is passed over.
 */
export function readLines(input: Readable, maxChars: number, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let cut = false
  // the last line ended with a CR, so a line feed right after it ends no other line
  let afterCr = false
  const emit = () => {
    onLine(cut ? `${pending} … [cut at ${maxChars} characters]` : pending)
    pending = ''
    cut = false
  }
  const take = (text: string) => {
    let start = 0
    if (afterCr && text.length > 0) {
      afterCr = false
      if (text[0] === '\n') {
        start = 1
      }
    }
    const ends = /[\r\n]/g
    for (;;) {
      ends.lastIndex = start
      const end = ends.exec(text)
      if (!cut) {
        pending += text.slice(start, end ? end.index : undefined)
        if (pending.length > maxChars) {
          pending = pending.slice(0, maxChars)
          cut = true
        }
      }
      if (!end) {
        return
      }
      emit()
      start = end.index + 1
      if (end[0] === '\r') {
        if (start === text.length) {
          afterCr = true
          return
        }
        if (text[start] === '\n') {
          start++
        }
      }
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
