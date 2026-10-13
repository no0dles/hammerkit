import type { SearchResult, TreeResult } from '../server/sandbox-files'

// Lines as grep tools print them: `path:line: text` for a match, `path-line- text` around
// one, the file names alone or `path:count`, with a note when the server answered a part.
export function formatSearch(result: SearchResult): string {
  let lines: string[]
  if (result.output_mode === 'files_with_matches') {
    lines = result.files ?? []
  } else if (result.output_mode === 'count') {
    lines = (result.counts ?? []).map((count) => `${count.path}:${count.count}`)
  } else {
    lines = (result.matches ?? []).map((match) =>
      match.context ? `${match.path}-${match.line}- ${match.text}` : `${match.path}:${match.line}: ${match.text}`
    )
  }
  if (lines.length === 0) {
    return 'No matches found'
  }
  if (result.truncated) {
    lines.push(
      '',
      `(${lines.length} of ${result.exact ? '' : 'at least '}${
        result.total
      } shown, narrow the search or ask with a higher limit)`
    )
  }
  return lines.join('\n')
}

// The paths of a listing, a directory with a trailing `/`.
export function formatTree(result: TreeResult, prefix = ''): string {
  const lines = result.entries.map((entry) => {
    const path = prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
    return entry.type === 'directory' ? `${path}/` : path
  })
  if (lines.length === 0) {
    return 'No files found'
  }
  if (result.truncated) {
    lines.push('', `(${result.entries.length} of ${result.total} shown, narrow the pattern)`)
  }
  return lines.join('\n')
}

// The server numbers lines like `cat -n` (`     1\tline`); some harnesses print `1: line`.
export function toColonNumbers(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\t(.*)$/s.exec(line)
      return match ? `${match[1]}: ${match[2]}` : line
    })
    .join('\n')
}

// The most of a command's output a tool answers: its first and last lines, up to about 30 KB.
// One `cat` of a big file or a verbose install would otherwise fill the model's context.
const HEAD_LINES = 50
const TAIL_LINES = 200
const MAX_CHARS = 30_000

/**
 * The head and the tail of a long output, with a line in between that says how much is cut
 * and how to read it (`readMore`, for example the run_logs call for the run).
 */
export function capOutput(output: string, readMore: string): string {
  const lines = output.split('\n')
  if (lines.length <= HEAD_LINES + TAIL_LINES && output.length <= MAX_CHARS) {
    return output
  }
  const many = lines.length > HEAD_LINES + TAIL_LINES
  // the end tells most of how a command went: it gets the larger part
  const head = (many ? lines.slice(0, HEAD_LINES).join('\n') : output).slice(0, MAX_CHARS / 4)
  const tail = (many ? lines.slice(-TAIL_LINES).join('\n') : output).slice(-(MAX_CHARS * 3) / 4)
  return `${head}\n… the output is cut here, it has ${lines.length} lines in all: ${readMore}\n${tail}`
}
