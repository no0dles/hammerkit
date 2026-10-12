import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FilePatch, parsePatch, PatchError } from './sandbox-patch'

// The result of a patch on files given as { path: content }.
function applyTo(files: { [path: string]: string }, patch: string): { [path: string]: string } {
  const result = { ...files }
  for (const file of parsePatch(patch)) {
    const content = file.from !== undefined ? result[file.from] : ''
    if (file.from !== undefined && content === undefined) {
      throw new Error(`${file.from} does not exist`)
    }
    const changed = file.apply(content)
    if (file.from !== undefined && file.from !== file.to && !file.copy) {
      delete result[file.from]
    }
    if (file.to !== undefined) {
      result[file.to] = changed
    }
  }
  return result
}

describe('patches', () => {
  describe('git diffs', () => {
    let repository: string
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
        { cwd: repository, encoding: 'utf8' }
      )

    beforeEach(() => {
      repository = mkdtempSync(join(tmpdir(), 'hammerkit-patch-'))
      git('init', '--quiet')
      git('config', 'core.autocrlf', 'false')
    })
    afterEach(() => rmSync(repository, { recursive: true, force: true }))

    // What git writes for the change from `before` to `after`, applied to `before`, is `after`.
    function roundTrip(before: { [path: string]: string }, after: { [path: string]: string }) {
      for (const [path, content] of Object.entries(before)) {
        writeFileSync(join(repository, path), content)
      }
      git('add', '--all')
      git('commit', '--quiet', '--allow-empty', '-m', 'before')
      for (const path of Object.keys(before)) {
        rmSync(join(repository, path))
      }
      for (const [path, content] of Object.entries(after)) {
        writeFileSync(join(repository, path), content)
      }
      git('add', '--all')
      const patch = git('diff', '--cached', '-M', 'HEAD')
      expect(applyTo(before, patch)).toEqual(after)
      return patch
    }

    const lines = (count: number, change: (n: number) => string = (n) => `line ${n}`) =>
      Array.from({ length: count }, (_, n) => change(n + 1)).join('\n') + '\n'

    it('modifies, adds and deletes files', () => {
      roundTrip(
        { 'a.txt': lines(40), 'gone.txt': 'bye\n' },
        { 'a.txt': lines(40, (n) => (n === 3 || n === 30 ? `changed ${n}` : `line ${n}`)), 'new.txt': 'hello\n' }
      )
    })

    it('renames a file with changes', () => {
      const content = lines(20)
      const patch = roundTrip({ 'old.txt': content }, { 'new.txt': content.replace('line 5\n', 'line five\n') })
      expect(patch).toContain('rename from old.txt')
    })

    it('keeps a missing newline at the end, adds and removes one', () => {
      roundTrip({ 'a.txt': 'one\ntwo' }, { 'a.txt': 'one\nthree' })
      roundTrip({ 'b.txt': 'one\ntwo' }, { 'b.txt': 'one\ntwo\n' })
      roundTrip({ 'c.txt': 'one\ntwo\n' }, { 'c.txt': 'one\ntwo' })
    })

    it('applies a hunk whose lines moved, as git apply does', () => {
      const patch = roundTrip(
        { 'a.txt': lines(30) },
        { 'a.txt': lines(30, (n) => (n === 20 ? 'twenty' : `line ${n}`)) }
      )
      const moved = `extra 1\nextra 2\n${lines(30)}`
      expect(applyTo({ 'a.txt': moved }, patch)['a.txt']).toBe(moved.replace('line 20\n', 'twenty\n'))
    })

    it('keeps the CRLF line endings of a file', () => {
      writeFileSync(join(repository, 'x'), '')
      const patch = ['--- a/win.txt', '+++ b/win.txt', '@@ -1,2 +1,2 @@', ' one', '-two', '+zwei', ''].join('\n')
      expect(applyTo({ 'win.txt': 'one\r\ntwo\r\n' }, patch)['win.txt']).toBe('one\r\nzwei\r\n')
    })

    it('names the hunk that does not apply', () => {
      const patch = roundTrip({ 'a.txt': lines(10) }, { 'a.txt': lines(10, (n) => (n === 5 ? 'five' : `line ${n}`)) })
      expect(() => applyTo({ 'a.txt': 'something else\n' }, patch)).toThrow(/a\.txt: hunk 1 \(@@ -2,7\) does not apply/)
    })

    it('reads the patch of format-patch, with its commit message around it', () => {
      roundTrip({ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' })
      git('commit', '--quiet', '-m', 'the change\n\nwith a body line\n--- that looks like a header')
      const patch = git('format-patch', '-1', '--stdout')
      expect(applyTo({ 'a.txt': 'one\n' }, patch)).toEqual({ 'a.txt': 'two\n' })
    })

    it('reads paths with spaces and quoted paths', () => {
      roundTrip({ 'with space.txt': 'a\n', 'ümlaut.txt': 'b\n' }, { 'with space.txt': 'aa\n', 'ümlaut.txt': 'bb\n' })
    })

    it('takes executable bits and refuses links and binary changes', () => {
      const exec = parsePatch(
        ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')
      ) as FilePatch[]
      expect(exec).toMatchObject([{ from: 'run.sh', to: 'run.sh', exec: true }])
      expect(exec[0].apply('x\n')).toBe('x\n')
      expect(() =>
        parsePatch(
          ['diff --git a/l b/l', 'new file mode 120000', '--- /dev/null', '+++ b/l', '@@ -0,0 +1 @@', '+x'].join('\n')
        )
      ).toThrow(/symbolic link or a submodule/)
      expect(() =>
        parsePatch(
          ['diff --git a/x.png b/x.png', 'index 1..2 100644', 'Binary files a/x.png and b/x.png differ'].join('\n')
        )
      ).toThrow(/x\.png: binary changes can not be applied/)
    })

    it('reads a plain diff -u', () => {
      const patch = [
        '--- old/a.txt\t2026-10-12 10:00:00',
        '+++ new/a.txt\t2026-10-12 10:01:00',
        '@@ -1 +1 @@',
        '-one',
        '+two',
        '',
      ].join('\n')
      expect(applyTo({ 'old/a.txt': 'one\n' }, patch)).toEqual({ 'old/a.txt': 'two\n' })
    })

    it('refuses what is no patch', () => {
      expect(() => parsePatch('just some text')).toThrow(PatchError)
      expect(() => parsePatch(['--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' one'].join('\n'))).toThrow(
        /hunk 1 ends before its last line/
      )
    })
  })

  describe('apply_patch', () => {
    it('adds, updates, moves and deletes files', () => {
      const patch = [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+export const answer = 42',
        '*** Update File: src/app.ts',
        '*** Move to: src/main.ts',
        '@@ function main() {',
        '   const a = 1',
        '-  return a',
        '+  return a + 1',
        '*** Delete File: old.txt',
        '*** End Patch',
      ].join('\n')
      const before = {
        'src/app.ts': 'function helper() {\n  return a\n}\nfunction main() {\n  const a = 1\n  return a\n}\n',
        'old.txt': 'x\n',
      }
      expect(applyTo(before, patch)).toEqual({
        'src/new.ts': 'export const answer = 42\n',
        'src/main.ts': 'function helper() {\n  return a\n}\nfunction main() {\n  const a = 1\n  return a + 1\n}\n',
      })
    })

    it('finds lines with other trailing whitespace and at the end of the file', () => {
      const patch = [
        '*** Begin Patch',
        '*** Update File: a.py',
        '@@',
        ' def f():',
        '-    return 1',
        '+    return 2',
        '@@',
        ' x = 1',
        '+y = 2',
        '*** End of File',
        '*** End Patch',
      ].join('\n')
      expect(applyTo({ 'a.py': 'x = 1\ndef f():   \n    return 1\nx = 1\n' }, patch)['a.py']).toBe(
        'x = 1\ndef f():   \n    return 2\nx = 1\ny = 2\n'
      )
    })

    it('says which chunk is not in the file', () => {
      const patch = ['*** Begin Patch', '*** Update File: a.txt', '@@', '-missing', '+there', '*** End Patch'].join(
        '\n'
      )
      expect(() => applyTo({ 'a.txt': 'one\n' }, patch)).toThrow(/a\.txt: the lines of chunk 1 are not in the file/)
      expect(() => parsePatch('*** Begin Patch\n*** Update File: a.txt\n')).toThrow(/no \*\*\* End Patch/)
      expect(() => parsePatch('*** Begin Patch\n*** Add File: a.txt\nno plus\n*** End Patch')).toThrow(
        /every line of an added file starts with \+/
      )
    })
  })
})
