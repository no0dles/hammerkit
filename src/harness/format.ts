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
