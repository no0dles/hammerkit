import { Bundle } from './bundle'

// Text from a proposal is shown to somebody who decides on it, so nothing in it may
// rewrite the terminal or hide what it says: control and format characters (which
// include the ones that reorder text) are shown as `?`. Long lines are not cut,
// what is hidden behind a cut is what a reviewer needs to see.
export function visible(line: string): string {
  return line.replace(/\t/g, '  ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?')
}

// Beyond this many comparisons a file is shown whole instead of compared.
const MAX_CELLS = 4_000_000

export type DiffLine = { type: ' ' | '+' | '-'; text: string }

// The lines that differ, with `context` lines around each change.
export function diffLines(before: string[], after: string[], context = 2): DiffLine[] | undefined {
  if ((before.length + 1) * (after.length + 1) > MAX_CELLS) {
    return undefined
  }
  const n = before.length
  const m = after.length
  // lengths of the longest common suffixes
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const all: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      all.push({ type: ' ', text: before[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      all.push({ type: '-', text: before[i++] })
    } else {
      all.push({ type: '+', text: after[j++] })
    }
  }
  while (i < n) all.push({ type: '-', text: before[i++] })
  while (j < m) all.push({ type: '+', text: after[j++] })

  const keep = new Array<boolean>(all.length).fill(false)
  all.forEach((line, index) => {
    if (line.type !== ' ') {
      for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) {
        keep[k] = true
      }
    }
  })
  return all.filter((_, index) => keep[index])
}

const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// What a proposal changes against the version it follows, file by file.
export function diffBundles(base: Bundle | undefined, proposed: Bundle): string[] {
  const out: string[] = []
  const before = base?.files ?? {}
  const paths = [...new Set([...Object.keys(before), ...Object.keys(proposed.files)])].sort()
  for (const path of paths) {
    const old = before[path]
    const next = proposed.files[path]
    if (old === next) {
      continue
    }
    const status = old === undefined ? 'added' : next === undefined ? 'removed' : 'changed'
    out.push(`--- ${visible(path)} (${status})`)
    const compared = old !== undefined && next !== undefined ? diffLines(lines(old), lines(next)) : undefined
    if (compared) {
      compared.forEach((line) => out.push(`${line.type} ${visible(line.text)}`))
    } else {
      // added, removed or too large to compare: all of the old, then all of the new
      lines(old ?? '').forEach((line) => out.push(`- ${visible(line)}`))
      lines(next ?? '').forEach((line) => out.push(`+ ${visible(line)}`))
    }
  }
  if (base && base.entry !== proposed.entry) {
    out.unshift(`entry file: ${visible(base.entry)} -> ${visible(proposed.entry)}`)
  }
  return out
}
