/**
 * Patches for the files of a sandbox, in the two formats models are trained to write: a
 * unified diff as git writes it (`git diff`, `git format-patch`, `diff -u`), and the body of
 * OpenAI's `apply_patch` tool (`*** Begin Patch`). A patch is parsed into what it does per
 * file, and each file is changed in memory, so a batch of edits applies fully or not at all.
 */

export class PatchError extends Error {}

// What a patch does to one file.
export interface FilePatch {
  // the file it reads, none when it adds one
  from?: string
  // the file it writes, none when it deletes one
  to?: string
  // `from` stays, the patch writes a copy of it to `to`
  copy?: boolean
  // executable after the patch, when the patch says
  exec?: boolean
  // the content after the patch, from the content before ('' when the file is added)
  apply(content: string): string
}

export function parsePatch(text: string): FilePatch[] {
  const files = /^\s*\*\*\* Begin Patch/.test(text) ? parseApplyPatch(text) : parseUnifiedDiff(text)
  if (files.length === 0) {
    throw new PatchError('the patch changes no file: send a unified diff or an apply_patch body (*** Begin Patch)')
  }
  return files
}

interface Line {
  kind: ' ' | '-' | '+'
  text: string
}

// A file's lines without their line feeds, whether the last one had one, and whether the
// file ends its lines with CRLF. Lines that come from a patch are compared without a
// trailing CR, and the lines a patch adds get the file's line ending.
interface Lines {
  lines: string[]
  finalNewline: boolean
  crlf: boolean
}

function splitLines(content: string): Lines {
  if (content === '') {
    return { lines: [], finalNewline: true, crlf: false }
  }
  const lines = content.split('\n')
  const finalNewline = lines[lines.length - 1] === ''
  if (finalNewline) {
    lines.pop()
  }
  const crlf = lines.filter((line) => line.endsWith('\r')).length * 2 > lines.length
  return { lines, finalNewline, crlf }
}

function joinLines({ lines, finalNewline }: Lines): string {
  return lines.length === 0 ? '' : lines.join('\n') + (finalNewline ? '\n' : '')
}

const stripCr = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)

// Replaces `length` lines at `at` with the new side of `block`: context keeps the file's
// own line, added lines take the file's line ending.
function splice(file: Lines, at: number, block: Line[]): number {
  const replacement: string[] = []
  let index = at
  for (const line of block) {
    if (line.kind === ' ') {
      replacement.push(file.lines[index++])
    } else if (line.kind === '-') {
      index++
    } else {
      const text = stripCr(line.text)
      replacement.push(file.crlf ? `${text}\r` : text)
    }
  }
  file.lines.splice(at, index - at, ...replacement)
  return at + replacement.length
}

function oldSide(block: Line[]): string[] {
  return block.filter((line) => line.kind !== '+').map((line) => line.text)
}

// Lines one file's patch may compare to place its hunks. A hunk that is nowhere in a large
// file would otherwise be compared with every place in it, its whole length at each.
export const MAX_COMPARED_LINES = 20_000_000

let compared = 0

function startComparing(): void {
  compared = 0
}

function compare(path: string): void {
  if (++compared > MAX_COMPARED_LINES) {
    throw new PatchError(
      `${path}: the patch's lines were compared with the file ${MAX_COMPARED_LINES} times without finding their place; give its hunks more lines of context or the line numbers of the file as it is`
    )
  }
}

function matchesAt(
  path: string,
  lines: string[],
  at: number,
  wanted: string[],
  same: (a: string, b: string) => boolean = (a, b) => stripCr(a) === stripCr(b)
): boolean {
  if (at < 0 || at + wanted.length > lines.length) {
    return false
  }
  return wanted.every((line, offset) => {
    compare(path)
    return same(lines[at + offset], line)
  })
}

// ---------------------------------------------------------------------------------------
// unified diff

interface Hunk {
  oldStart: number
  oldLength: number
  lines: Line[]
  // `\ No newline at end of file` after the old or the new side's last line
  oldNoNewline: boolean
  newNoNewline: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function parseUnifiedDiff(text: string): FilePatch[] {
  const lines = text.split('\n')
  const files: FilePatch[] = []
  let i = 0
  while (i < lines.length) {
    const line = stripCr(lines[i])
    if (line.startsWith('diff --git ')) {
      i = parseGitFile(lines, i, files)
    } else if (line.startsWith('--- ') && stripCr(lines[i + 1] ?? '').startsWith('+++ ')) {
      i = parsePlainFile(lines, i, files)
    } else {
      // a commit message of format-patch, `index` lines of other tools, a signature
      i++
    }
  }
  return files
}

interface Header {
  from?: string
  to?: string
  copy?: boolean
  exec?: boolean
}

function parseGitFile(lines: string[], start: number, files: FilePatch[]): number {
  const names = parseGitNames(stripCr(lines[start]).slice('diff --git '.length))
  const header: Header = { from: names?.[0], to: names?.[1] }
  let created = false
  let deleted = false
  let i = start + 1
  for (; i < lines.length; i++) {
    const line = stripCr(lines[i])
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('@@')) {
      break
    }
    if (line.startsWith('GIT binary patch') || /^Binary files .* differ$/.test(line)) {
      throw new PatchError(
        `${header.to ?? header.from ?? 'a file'}: binary changes can not be applied, write the file with PUT`
      )
    }
    const mode = /^(old mode|new mode|deleted file mode|new file mode) (\d+)$/.exec(line)
    if (mode) {
      const exec = parseMode(mode[2], header.to ?? header.from)
      if (mode[1] !== 'old mode' && mode[1] !== 'deleted file mode') {
        header.exec = exec
      }
      created ||= mode[1] === 'new file mode'
      deleted ||= mode[1] === 'deleted file mode'
      continue
    }
    const named = /^(rename from|rename to|copy from|copy to) (.+)$/.exec(line)
    if (named) {
      const path = unquote(named[2])
      if (named[1].endsWith('from')) {
        header.from = path
      } else {
        header.to = path
      }
      header.copy = named[1].startsWith('copy')
    }
  }
  if (i < lines.length && stripCr(lines[i]).startsWith('--- ')) {
    const from = parseFileName(stripCr(lines[i]).slice(4), 'a/')
    const to = parseFileName(stripCr(lines[i + 1] ?? '').slice(4), 'b/')
    header.from = from ?? undefined
    header.to = to ?? undefined
    created ||= from === null
    deleted ||= to === null
    i += 2
  }
  const [hunks, next] = parseHunks(lines, i, header.to ?? header.from ?? 'a file')
  if (created) {
    header.from = undefined
  }
  if (deleted) {
    header.to = undefined
  }
  if (!header.from && !header.to) {
    throw new PatchError(`the file of "${stripCr(lines[start])}" can not be read from the patch`)
  }
  files.push(filePatch(header, hunks))
  return next
}

function parsePlainFile(lines: string[], start: number, files: FilePatch[]): number {
  const from = parseFileName(stripCr(lines[start]).slice(4), 'a/')
  const to = parseFileName(stripCr(lines[start + 1]).slice(4), 'b/')
  const [hunks, next] = parseHunks(lines, start + 2, to ?? from ?? 'a file')
  if (from === null && to === null) {
    throw new PatchError('a patch from /dev/null to /dev/null changes nothing')
  }
  // a plain diff names the same file twice, maybe in two directories (`diff -u old/x new/x`)
  files.push(filePatch({ from: from ?? undefined, to: to === null ? undefined : from ?? to }, hunks))
  return next
}

function parseHunks(lines: string[], start: number, path: string): [Hunk[], number] {
  const hunks: Hunk[] = []
  let i = start
  while (i < lines.length) {
    const header = HUNK_HEADER.exec(stripCr(lines[i]))
    if (!header) {
      break
    }
    const hunk: Hunk = {
      oldStart: Number(header[1]),
      oldLength: header[2] === undefined ? 1 : Number(header[2]),
      lines: [],
      oldNoNewline: false,
      newNoNewline: false,
    }
    let oldLeft = hunk.oldLength
    let newLeft = header[4] === undefined ? 1 : Number(header[4])
    i++
    while (oldLeft > 0 || newLeft > 0) {
      if (i >= lines.length) {
        throw new PatchError(`${path}: hunk ${hunks.length + 1} ends before its last line`)
      }
      const line = lines[i]
      // editors drop the space of an empty context line
      const kind = line === '' || line === '\r' ? ' ' : line[0]
      if (kind !== ' ' && kind !== '-' && kind !== '+') {
        if (kind === '\\') {
          i++
          continue
        }
        throw new PatchError(
          `${path}: hunk ${hunks.length + 1} ends before its last line, at "${stripCr(line).slice(0, 80)}"`
        )
      }
      hunk.lines.push({ kind, text: line.slice(1) })
      if (kind !== '+') {
        oldLeft--
      }
      if (kind !== '-') {
        newLeft--
      }
      if (oldLeft < 0 || newLeft < 0) {
        throw new PatchError(`${path}: hunk ${hunks.length + 1} has more lines than its header says`)
      }
      i++
      if (lines[i]?.startsWith('\\')) {
        hunk.oldNoNewline ||= kind !== '+'
        hunk.newNoNewline ||= kind !== '-'
        i++
      }
    }
    hunks.push(hunk)
  }
  return [hunks, i]
}

function filePatch(header: Header, hunks: Hunk[]): FilePatch {
  const path = header.to ?? header.from ?? ''
  return {
    ...header,
    apply(content: string): string {
      startComparing()
      const file = splitLines(content)
      let delta = 0
      let cursor = 0
      hunks.forEach((hunk, index) => {
        const old = oldSide(hunk.lines)
        // where the hunk says it is, moved by what the hunks before it added or removed
        const expected = Math.max(cursor, nominal(hunk) + delta)
        const at = findNear(path, file.lines, old, expected, cursor)
        if (at < 0) {
          throw new PatchError(
            `${path}: hunk ${index + 1} (@@ -${hunk.oldStart},${
              hunk.oldLength
            }) does not apply, its lines are not in the file at line ${
              hunk.oldStart
            } or near it; read the file again and make the patch from what it holds`
          )
        }
        const end = splice(file, at, hunk.lines)
        delta = at - nominal(hunk) + (end - at - old.length)
        cursor = end
        // a hunk that reaches the end of the file says whether its last line has a line feed
        if (end === file.lines.length && hunk.lines.length > 0) {
          file.finalNewline = !hunk.newNoNewline
        }
      })
      return joinLines(file)
    },
  }
}

// The line a hunk starts at: `-5,0` inserts after line 5, `-5,2` replaces lines 5 and 6.
function nominal(hunk: Hunk): number {
  return hunk.oldLength === 0 ? hunk.oldStart : hunk.oldStart - 1
}

// The match closest to `expected` at or after `from`, the way git apply moves a hunk
// whose lines moved.
function findNear(path: string, lines: string[], wanted: string[], expected: number, from: number): number {
  const last = lines.length - wanted.length
  for (let distance = 0; expected - distance >= from || expected + distance <= last; distance++) {
    if (expected - distance >= from && matchesAt(path, lines, expected - distance, wanted)) {
      return expected - distance
    }
    if (distance > 0 && matchesAt(path, lines, expected + distance, wanted)) {
      return expected + distance
    }
  }
  return -1
}

function parseMode(mode: string, path: string | undefined): boolean {
  if (mode === '100755') {
    return true
  }
  if (mode === '100644') {
    return false
  }
  throw new PatchError(
    `${path ?? 'a file'}: mode ${mode} is a symbolic link or a submodule, a patch may only change files`
  )
}

// `a/x b/x` of a `diff --git` line. With spaces in the name the two halves are found by
// being the same path; renames name their paths in `rename from` / `rename to`.
function parseGitNames(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest)
    const from = unquote(rest.slice(0, end + 1))
    const to = unquote(rest.slice(end + 2))
    return [stripPrefix(from, 'a/'), stripPrefix(to, 'b/')]
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "')
    return [stripPrefix(rest.slice(0, start), 'a/'), stripPrefix(unquote(rest.slice(start + 1)), 'b/')]
  }
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest[half] === ' ') {
    const from = stripPrefix(rest.slice(0, half), 'a/')
    const to = stripPrefix(rest.slice(half + 1), 'b/')
    if (from === to) {
      return [from, to]
    }
  }
  return undefined
}

function quotedEnd(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '\\') {
      i++
    } else if (value[i] === '"') {
      return i
    }
  }
  throw new PatchError(`the quoted path ${value.slice(0, 80)} has no end`)
}

// `--- a/path\t2026-10-12 ...`, or /dev/null for a file that does not exist on that side
function parseFileName(value: string, prefix: string): string | null {
  const name = value.startsWith('"') ? unquote(value.slice(0, quotedEnd(value) + 1)) : value.split('\t')[0].trimEnd()
  if (name === '/dev/null') {
    return null
  }
  return stripPrefix(name, prefix)
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

// A path git quoted: C escapes, and octal escapes for the bytes of UTF-8.
function unquote(value: string): string {
  if (!value.startsWith('"')) {
    return value
  }
  const bytes: number[] = []
  const escapes: { [key: string]: number } = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  for (let i = 1; i < value.length - 1; i++) {
    const char = value[i]
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'))
      continue
    }
    const next = value[++i]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(value.slice(i, i + 3), 8))
      i += 2
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// ---------------------------------------------------------------------------------------
// apply_patch (V4A)

interface Chunk {
  // the line after `@@ `, which the chunk follows
  anchor?: string
  lines: Line[]
  // `*** End of File`: the chunk ends with the file
  endOfFile: boolean
}

function parseApplyPatch(text: string): FilePatch[] {
  const lines = text.split('\n').map(stripCr)
  let i = lines.findIndex((line) => line.trim() === '*** Begin Patch') + 1
  const files: FilePatch[] = []
  let ended = false
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '*** End Patch') {
      ended = true
      break
    }
    if (line.trim() === '') {
      i++
      continue
    }
    let match: RegExpExecArray | null
    if ((match = /^\*\*\* Add File: (.+)$/.exec(line))) {
      const content: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('***')) {
        if (!lines[i].startsWith('+')) {
          throw new PatchError(`${match[1]}: every line of an added file starts with +, not "${lines[i].slice(0, 80)}"`)
        }
        content.push(lines[i].slice(1))
        i++
      }
      const added = content.length === 0 ? '' : `${content.join('\n')}\n`
      files.push({ to: match[1].trim(), apply: () => added })
    } else if ((match = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      files.push({ from: match[1].trim(), apply: () => '' })
      i++
    } else if ((match = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const path = match[1].trim()
      let to = path
      i++
      const moved = /^\*\*\* Move to: (.+)$/.exec(lines[i] ?? '')
      if (moved) {
        to = moved[1].trim()
        i++
      }
      const chunks: Chunk[] = []
      for (; i < lines.length; i++) {
        const current = lines[i]
        if (current === '*** End of File') {
          if (chunks.length === 0) {
            throw new PatchError(`${path}: *** End of File before any change`)
          }
          chunks[chunks.length - 1].endOfFile = true
          continue
        }
        if (current.startsWith('***')) {
          break
        }
        if (current.startsWith('@@')) {
          const anchor = current.slice(2).trim()
          chunks.push({ anchor: anchor || undefined, lines: [], endOfFile: false })
          continue
        }
        if (chunks.length === 0) {
          chunks.push({ lines: [], endOfFile: false })
        }
        const kind = current === '' ? ' ' : current[0]
        if (kind !== ' ' && kind !== '-' && kind !== '+') {
          throw new PatchError(
            `${path}: "${current.slice(0, 80)}" is not a change, each line starts with a space, - or +`
          )
        }
        chunks[chunks.length - 1].lines.push({ kind, text: current.slice(1) })
      }
      files.push({ from: path, to, apply: (content) => applyChunks(path, content, chunks) })
    } else {
      throw new PatchError(
        `"${line.slice(
          0,
          80
        )}" is not an apply_patch line: expected *** Add File:, *** Update File:, *** Delete File: or *** End Patch`
      )
    }
  }
  if (!ended) {
    throw new PatchError('the patch has no *** End Patch line')
  }
  return files
}

const exact = (a: string, b: string) => stripCr(a) === stripCr(b)
const trailing = (a: string, b: string) => a.trimEnd() === b.trimEnd()
const trimmed = (a: string, b: string) => a.trim() === b.trim()

// The way apply_patch finds its lines: after the chunk before it, exactly, then with
// trailing and then all surrounding whitespace ignored.
function applyChunks(path: string, content: string, chunks: Chunk[]): string {
  startComparing()
  const file = splitLines(content)
  let cursor = 0
  chunks.forEach((chunk, index) => {
    if (chunk.anchor !== undefined) {
      const anchor = chunk.anchor
      const found = [exact, trimmed]
        .map((same) =>
          file.lines.findIndex((line, at) => {
            if (at < cursor) {
              return false
            }
            compare(path)
            return same(line, anchor)
          })
        )
        .find((at) => at >= 0)
      if (found === undefined) {
        throw new PatchError(
          `${path}: chunk ${index + 1} follows "${anchor.slice(
            0,
            80
          )}", which is not in the file after the chunk before it`
        )
      }
      cursor = found + 1
    }
    if (chunk.lines.length === 0) {
      return
    }
    const old = oldSide(chunk.lines)
    let at = -1
    for (const same of [exact, trailing, trimmed]) {
      if (chunk.endOfFile && matchesAt(path, file.lines, file.lines.length - old.length, old, same)) {
        at = file.lines.length - old.length
        break
      }
      at =
        old.length === 0
          ? chunk.endOfFile
            ? file.lines.length
            : cursor
          : file.lines.findIndex((_, start) => start >= cursor && matchesAt(path, file.lines, start, old, same))
      if (at >= 0) {
        break
      }
    }
    if (at < 0) {
      throw new PatchError(
        `${path}: the lines of chunk ${index + 1} are not in the file${
          old.length > 0 ? ` (it starts with "${old[0].slice(0, 80)}")` : ''
        }; read the file again and make the patch from what it holds`
      )
    }
    cursor = splice(file, at, chunk.lines)
  })
  return joinLines(file)
}
