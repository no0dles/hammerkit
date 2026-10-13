import { execFileSync } from 'child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SandboxFileError, SandboxFiles } from './sandbox-files'
import { HostSandboxStorage } from './sandbox-storage'

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  )
}

// Creating a symbolic link needs a privilege on Windows; where it can not be made, there
// is no link for a task to make either.
function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path)
    return true
  } catch {
    return false
  }
}

async function failure(promise: Promise<unknown>): Promise<SandboxFileError> {
  try {
    await promise
  } catch (e) {
    if (e instanceof SandboxFileError) {
      return e
    }
    throw e
  }
  throw new Error('expected the call to fail')
}

describe('sandbox files', () => {
  let root: string
  let repository: string
  let storage: HostSandboxStorage
  let files: SandboxFiles
  let work: string
  const id = 'sbx_test'
  const key = { id, owner: { iss: 'https://idp.test', sub: 'alice' } }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-sandbox-files-'))
    repository = join(root, 'repository')
    mkdirSync(join(repository, 'src', 'deep'), { recursive: true })
    git(repository, 'init', '--quiet', '--initial-branch=main')
    git(repository, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(repository, 'README.md'), '# payments\n\nhello world\n')
    writeFileSync(join(repository, 'src', 'app.ts'), 'export function main() {\n  return 1\n}\n')
    writeFileSync(join(repository, 'src', 'deep', 'util.ts'), 'export const Hello = 2\nexport const other = 3\n')
    writeFileSync(join(repository, '.gitignore'), 'node_modules\n')
    writeFileSync(join(repository, '.env.example'), 'TOKEN=\n')
    git(repository, 'add', '--all')
    git(repository, 'commit', '--quiet', '-m', 'one')
    storage = new HostSandboxStorage(join(root, 'sandboxes'), process.env)
    await storage.create(key, {
      url: repository,
      ref: 'main',
      env: process.env as { [key: string]: string },
      signal: AbortSignal.timeout(60_000),
    })
    work = (await storage.attach(key)).directory
    files = storage.files(key)
    // what tasks leave in a sandbox: ignored files and a credential
    mkdirSync(join(work, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(work, 'node_modules', 'dep', 'index.js'), 'hello from a dependency\n')
    writeFileSync(join(work, '.env'), 'TOKEN=hello-secret\n')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  describe('tree', () => {
    it('lists what git sees, one level at a time, without the deny list', async () => {
      const top = await files.tree({})
      expect(top.entries).toEqual([
        { path: '.env.example', type: 'file', size: 7 },
        { path: '.gitignore', type: 'file', size: 13 },
        { path: 'README.md', type: 'file', size: 24 },
        { path: 'src', type: 'directory' },
      ])
      expect(top).toMatchObject({ path: '', total: 4, truncated: false, cursor: null })
      const deep = await files.tree({ path: 'src', depth: 5 })
      expect(deep.entries.map((entry) => entry.path)).toEqual(['src/app.ts', 'src/deep', 'src/deep/util.ts'])
    })

    it('matches a glob and pages with a cursor', async () => {
      writeFileSync(join(work, 'src', 'new.ts'), 'new\n')
      const first = await files.tree({ glob: '**/*.ts', limit: 2 })
      expect(first.entries.map((entry) => entry.path)).toEqual(['src/app.ts', 'src/deep/util.ts'])
      expect(first).toMatchObject({ total: 3, truncated: true })
      const second = await files.tree({ glob: '**/*.ts', limit: 2, cursor: first.cursor as string })
      expect(second.entries.map((entry) => entry.path)).toEqual(['src/new.ts'])
      expect(second.truncated).toBe(false)
    })

    it('shows a link as a link and refuses paths outside', async () => {
      if (link('/etc', join(work, 'etc'))) {
        const top = await files.tree({})
        // Windows answers the target as a drive path
        expect(top.entries).toContainEqual({ path: 'etc', type: 'symlink', target: expect.stringMatching(/etc$/) })
        expect((await failure(files.tree({ path: 'etc' }))).message).toBe('etc is a symbolic link')
      }
      expect((await failure(files.tree({ path: '../x' }))).status).toBe(400)
      expect((await failure(files.tree({ path: 'missing' }))).status).toBe(404)
    })
  })

  describe('reading', () => {
    it('numbers the lines and reads a range', async () => {
      const read = await files.read('README.md', {})
      expect(read).toMatchObject({
        path: 'README.md',
        size: 24,
        lines: 3,
        offset: 1,
        content: '     1\t# payments\n     2\t\n     3\thello world',
        truncated: false,
        nextOffset: null,
      })
      expect(read.sha256).toMatch(/^[0-9a-f]{64}$/)
      const range = await files.read('README.md', { offset: 2, limit: 1 })
      expect(range).toMatchObject({ content: '     2\t', truncated: true, nextOffset: 3 })
    })

    it('refuses the deny list, traversal, binary files and links', async () => {
      expect(await failure(files.read('.env', {}))).toMatchObject({ status: 403 })
      expect((await failure(files.read('.git/config', {}))).status).toBe(403)
      expect((await failure(files.read('src/../../x', {}))).status).toBe(400)
      expect((await failure(files.read('/etc/passwd', {}))).status).toBe(400)
      expect((await failure(files.read('src', {}))).message).toBe('src is a directory, list it with tree')
      writeFileSync(join(work, 'image.bin'), Buffer.from([1, 0, 2]))
      expect((await failure(files.read('image.bin', {}))).status).toBe(415)
      expect((await files.raw('image.bin')).content).toEqual(Buffer.from([1, 0, 2]))
      if (link(join(repository, 'README.md'), join(work, 'outside.md'))) {
        expect((await failure(files.read('outside.md', {}))).message).toMatch(/is a symbolic link/)
        expect((await failure(files.raw('outside.md'))).status).toBe(400)
      }
      if (link(repository, join(work, 'linked'))) {
        expect((await failure(files.read('linked/README.md', {}))).message).toBe(
          'linked is a symbolic link, the API does not follow links'
        )
      }
    })

    it('stats files, directories and what is missing', async () => {
      expect(await files.stat('src/app.ts')).toMatchObject({ path: 'src/app.ts', type: 'file', size: 38, exec: false })
      expect(await files.stat('src')).toMatchObject({ type: 'directory' })
      expect(await files.stat('nothing/here')).toBeUndefined()
    })
  })

  describe('search', () => {
    it('finds files, lines with context and counts, as ripgrep does', async () => {
      const found = await files.search({ pattern: 'hello', i: true })
      // node_modules is ignored by .gitignore and .env is on the deny list
      expect(found).toMatchObject({ files: ['README.md', 'src/deep/util.ts'], total: 2, exact: true })
      const content = await files.search({ pattern: 'other', output_mode: 'content', B: 1 })
      expect(content.matches).toEqual([
        { path: 'src/deep/util.ts', line: 1, text: 'export const Hello = 2', context: true },
        { path: 'src/deep/util.ts', line: 2, text: 'export const other = 3' },
      ])
      const counts = await files.search({ pattern: 'export', output_mode: 'count', glob: ['*.ts'] })
      expect(counts.counts).toEqual([
        { path: 'src/app.ts', count: 1 },
        { path: 'src/deep/util.ts', count: 2 },
      ])
      const scoped = await files.search({ pattern: 'export', path: 'src/deep' })
      expect(scoped.files).toEqual(['src/deep/util.ts'])
    })

    it('pages with a cursor and answers ripgrep errors', async () => {
      const first = await files.search({ pattern: 'e', head_limit: 2 })
      expect(first).toMatchObject({ total: 4, truncated: true })
      expect(first.files).toEqual(['.gitignore', 'README.md'])
      const second = await files.search({ pattern: 'e', head_limit: 2, cursor: first.cursor as string })
      expect(second.files).toEqual(['src/app.ts', 'src/deep/util.ts'])
      expect(second).toMatchObject({ truncated: false, cursor: null })
      const error = await failure(files.search({ pattern: '(' }))
      expect(error.status).toBe(400)
      expect(error.message).toMatch(/regex parse error/)
      expect((await files.search({ pattern: '--not-a-flag', fixed_strings: true })).files).toEqual([])
    })
  })

  describe('edits', () => {
    it('replaces a string that is there once, or everywhere', async () => {
      const plan = await files.plan([
        { op: 'replace', path: 'src/app.ts', old_string: 'return 1', new_string: 'return 2' },
      ])
      expect(plan.files).toEqual([
        { path: 'src/app.ts', change: 'modified', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), size: 38 },
      ])
      expect(plan.bytes).toBe(0)
      // planned, not written
      expect(readFileSync(join(work, 'src', 'app.ts'), 'utf8')).toContain('return 1')
      await plan.commit()
      expect(readFileSync(join(work, 'src', 'app.ts'), 'utf8')).toContain('return 2')

      const twice = await failure(
        files.plan([{ op: 'replace', path: 'src/deep/util.ts', old_string: 'export', new_string: 'let' }])
      )
      expect(twice.message).toBe(
        'op 0 (replace): old_string is 2 times in src/deep/util.ts, at lines 1, 2: add lines around it until it is there once, or set replace_all'
      )
      expect(twice.details).toEqual({ lines: [1, 2], op: 0 })
      const all = await files.plan([
        { op: 'replace', path: 'src/deep/util.ts', old_string: 'export ', new_string: '', replace_all: true },
      ])
      await all.commit()
      expect(readFileSync(join(work, 'src', 'deep', 'util.ts'), 'utf8')).toBe('const Hello = 2\nconst other = 3\n')
      const missing = await failure(
        files.plan([{ op: 'replace', path: 'README.md', old_string: 'nope', new_string: 'x' }])
      )
      expect(missing.message).toMatch(/old_string is not in README\.md/)
    })

    it('writes, moves and deletes in one batch, or not at all', async () => {
      const failing = await failure(
        files.plan([
          { op: 'write', path: 'docs/new/guide.md', content: 'guide\n' },
          { op: 'delete', path: 'missing.txt' },
        ])
      )
      expect(failing).toMatchObject({ status: 404, message: 'op 1 (delete): missing.txt does not exist' })
      expect(existsSync(join(work, 'docs'))).toBe(false)

      const plan = await files.plan([
        { op: 'write', path: 'docs/new/guide.md', content: 'guide\n' },
        { op: 'move', path: 'README.md', to: 'docs/README.md' },
        { op: 'delete', path: '.env.example' },
        { op: 'write', path: 'bin.dat', content: Buffer.from([0, 1, 2]).toString('base64'), encoding: 'base64' },
      ])
      expect(plan.files.map((file) => [file.path, file.change])).toEqual([
        ['.env.example', 'deleted'],
        ['README.md', 'deleted'],
        ['bin.dat', 'added'],
        ['docs/README.md', 'added'],
        ['docs/new/guide.md', 'added'],
      ])
      expect(plan.bytes).toBe(6 + 3 - 7)
      await plan.commit()
      expect(readFileSync(join(work, 'docs', 'new', 'guide.md'), 'utf8')).toBe('guide\n')
      expect(readFileSync(join(work, 'docs', 'README.md'), 'utf8')).toBe('# payments\n\nhello world\n')
      expect(readFileSync(join(work, 'bin.dat'))).toEqual(Buffer.from([0, 1, 2]))
      expect(existsSync(join(work, 'README.md'))).toBe(false)
      expect(existsSync(join(work, '.env.example'))).toBe(false)
    })

    it('checks the hash a file was read with', async () => {
      const { sha256 } = await files.read('README.md', {})
      writeFileSync(join(work, 'README.md'), 'changed by a run\n')
      const stale = await failure(files.plan([{ op: 'write', path: 'README.md', content: 'x', ifHash: sha256 }]))
      expect(stale.status).toBe(412)
      expect(stale.message).toMatch(/README\.md changed since you read it/)
    })

    it('applies a git diff and an apply_patch body', async () => {
      const diff = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,3 @@',
        ' export function main() {',
        '-  return 1',
        '+  return 3',
        ' }',
        'diff --git a/src/added.ts b/src/added.ts',
        'new file mode 100755',
        '--- /dev/null',
        '+++ b/src/added.ts',
        '@@ -0,0 +1 @@',
        '+#!/bin/sh',
        '',
      ].join('\n')
      const applyPatch = [
        '*** Begin Patch',
        '*** Update File: README.md',
        '@@',
        '-hello world',
        '+hello sandbox',
        '*** End Patch',
      ].join('\n')
      await (
        await files.plan([
          { op: 'patch', patch: diff },
          { op: 'patch', patch: applyPatch },
        ])
      ).commit()
      expect(readFileSync(join(work, 'src', 'app.ts'), 'utf8')).toContain('return 3')
      expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('# payments\n\nhello sandbox\n')
      expect(await files.stat('src/added.ts')).toMatchObject({
        exec: process.platform !== 'win32',
      })
      const wrong = await failure(files.plan([{ op: 'patch', patch: applyPatch }]))
      expect(wrong).toMatchObject({ status: 422, details: { op: 0 } })
      expect(wrong.message).toMatch(/^op 0 \(patch\): README\.md: the lines of chunk 1 are not in the file/)
    })

    it('replaces a link instead of writing through it, and keeps out of the deny list', async () => {
      const outside = join(root, 'outside.txt')
      writeFileSync(outside, 'outside\n')
      if (link(outside, join(work, 'link.txt'))) {
        expect(
          (await failure(files.plan([{ op: 'replace', path: 'link.txt', old_string: 'o', new_string: 'x' }]))).message
        ).toBe('op 0 (replace): link.txt is a symbolic link, the API does not replace in links')
        await (await files.plan([{ op: 'write', path: 'link.txt', content: 'inside\n' }])).commit()
        expect(lstatSync(join(work, 'link.txt')).isSymbolicLink()).toBe(false)
        expect(readFileSync(outside, 'utf8')).toBe('outside\n')
      }
      if (link(root, join(work, 'escape'))) {
        expect((await failure(files.plan([{ op: 'write', path: 'escape/x.txt', content: 'x' }]))).message).toBe(
          'op 0 (write): escape is a symbolic link, not a directory'
        )
        expect(existsSync(join(root, 'x.txt'))).toBe(false)
      }
      expect((await failure(files.plan([{ op: 'write', path: '.npmrc', content: 'x' }]))).status).toBe(403)
      expect((await failure(files.plan([{ op: 'move', path: 'README.md', to: '.git/config' }]))).status).toBe(403)
    })
  })

  describe('what a task leaves behind', () => {
    it('never reads or writes through a link out of the sandbox', async () => {
      const outside = join(root, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret\n')
      if (!link(outside, join(work, 'escape')) || !link(join(outside, 'secret.txt'), join(work, 'secret.txt'))) {
        return
      }
      for (const path of ['escape/secret.txt', 'secret.txt']) {
        expect((await failure(files.read(path, {}))).status).toBe(400)
        expect((await failure(files.raw(path))).status).toBe(400)
      }
      expect(await files.stat('escape')).toMatchObject({ type: 'symlink' })
      expect((await failure(files.stat('escape/secret.txt'))).status).toBe(400)
      expect((await failure(files.tree({ path: 'escape' }))).status).toBe(400)
      expect((await failure(files.search({ pattern: 'outside', path: 'escape' }))).status).toBe(400)
      expect((await files.search({ pattern: 'outside-secret' })).files).toEqual([])
      const ops = [
        { op: 'write', path: 'escape/new.txt', content: 'x' },
        { op: 'replace', path: 'escape/secret.txt', old_string: 'outside', new_string: 'x' },
        { op: 'replace', path: 'secret.txt', old_string: 'outside', new_string: 'x' },
        { op: 'delete', path: 'escape/secret.txt' },
        { op: 'move', path: 'README.md', to: 'escape/README.md' },
        { op: 'move', path: 'escape/secret.txt', to: 'stolen.txt' },
        { op: 'patch', patch: '--- /dev/null\n+++ b/escape/new.txt\n@@ -0,0 +1 @@\n+x\n' },
        { op: 'patch', patch: '--- a/escape/secret.txt\n+++ b/escape/secret.txt\n@@ -1 +1 @@\n-outside-secret\n+x\n' },
        { op: 'patch', patch: '*** Begin Patch\n*** Add File: escape/new.txt\n+x\n*** End Patch\n' },
      ] as const
      for (const op of ops) {
        expect((await failure(files.plan([op]))).status).toBeGreaterThanOrEqual(400)
      }
      expect(readdirSync(outside)).toEqual(['secret.txt'])
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside-secret\n')
      expect(await files.diff('diff', { name: 'a', email: 'a@b', message: 'm' })).not.toContain('outside-secret')
    })

    it('refuses pipes instead of waiting on them', async () => {
      try {
        execFileSync('mkfifo', [join(work, 'pipe')])
      } catch {
        // no pipes to make on this system
        return
      }
      expect(await files.stat('pipe')).toMatchObject({ type: 'other', size: 0, exec: false })
      expect((await failure(files.read('pipe', {}))).message).toBe('pipe is a pipe, a socket or a device, not a file')
      expect((await failure(files.raw('pipe'))).status).toBe(400)
      expect((await failure(files.search({ pattern: 'x', path: 'pipe' }))).status).toBe(400)
      expect(
        (await failure(files.plan([{ op: 'replace', path: 'pipe', old_string: 'a', new_string: 'b' }]))).status
      ).toBe(400)
      // git does not see pipes, so tree does not list them
      expect((await files.tree({})).entries.map((entry) => entry.path)).not.toContain('pipe')
    })

    it('denies credential directories in any case', async () => {
      mkdirSync(join(work, '.SSH'))
      writeFileSync(join(work, '.SSH', 'config'), 'Host *\n')
      expect((await failure(files.read('.SSH/config', {}))).status).toBe(403)
      expect((await failure(files.plan([{ op: 'write', path: '.Git/config', content: 'x' }]))).status).toBe(403)
      expect((await failure(files.plan([{ op: 'write', path: '.aws./credentials', content: 'x' }]))).status).toBe(403)
      expect((await files.search({ pattern: 'Host' })).files).toEqual([])
      expect((await files.tree({})).entries.map((entry) => entry.path)).not.toContain('.SSH')
    })

    it('leaves a repository a task made out of the changes', async () => {
      const nested = join(work, 'nested')
      mkdirSync(nested)
      writeFileSync(join(nested, 'file.txt'), 'nested\n')
      git(nested, 'init', '--quiet')
      git(nested, 'add', '--all')
      git(nested, 'commit', '--quiet', '-m', 'nested')
      const commit = git(nested, 'rev-parse', 'HEAD').trim()
      writeFileSync(join(work, 'added.txt'), 'added\n')
      expect((await files.changes()).map((file) => file.path)).toEqual(['added.txt'])
      const diff = await files.diff('diff', { name: 'a', email: 'a@b', message: 'm' })
      expect(diff).not.toContain(commit)
      expect(diff).not.toContain('Subproject')
      expect(await files.diff('patch', { name: 'a', email: 'a@b', message: 'm' })).not.toContain(commit)
    })

    it('reads a file of many lines without splitting all of it', async () => {
      writeFileSync(join(work, 'lines.txt'), '\n'.repeat(4 * 1024 * 1024))
      const read = await files.read('lines.txt', { offset: 3, limit: 2 })
      expect(read).toMatchObject({ lines: 4 * 1024 * 1024, content: '     3\t\n     4\t', nextOffset: 5 })
      const all = await Promise.all([1, 2, 3, 4, 5, 6].map(() => files.raw('lines.txt')))
      expect(all.map((raw) => raw.content?.length)).toEqual(Array(6).fill(4 * 1024 * 1024))
    })
  })

  describe('changes', () => {
    it('summarizes and diffs the files against the commit, without the deny list', async () => {
      await (
        await files.plan([
          { op: 'replace', path: 'README.md', old_string: 'hello world', new_string: 'hello sandbox' },
          { op: 'write', path: 'src/new.ts', content: 'one\ntwo\n' },
          { op: 'delete', path: 'src/deep/util.ts' },
        ])
      ).commit()
      writeFileSync(join(work, 'id_rsa'), 'a key\n')
      expect(await files.changes()).toEqual([
        { path: 'README.md', status: 'modified', additions: 1, deletions: 1 },
        { path: 'src/deep/util.ts', status: 'deleted', additions: 0, deletions: 2 },
        { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 },
      ])
      const diff = await files.diff('diff', { name: 'a', email: 'a@b', message: 'm' })
      expect(diff).toContain('+hello sandbox')
      expect(diff).not.toContain('a key')
      expect(diff).not.toContain('hello-secret')

      const patch = await files.diff('patch', { name: 'Agent', email: 'agent@corp', message: 'Say hello' })
      expect(patch).toContain('From: Agent <agent@corp>')
      expect(patch).toContain('Subject: [PATCH] Say hello')
      // the patch makes the same change in a clone, as a commit
      const clone = join(root, 'clone')
      // as the repository holds them, also where git turns line feeds into CRLF on checkout
      git(root, 'clone', '--quiet', '--config', 'core.autocrlf=false', repository, clone)
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'am', '--quiet'],
        { cwd: clone, input: patch }
      )
      expect(readFileSync(join(clone, 'src', 'new.ts'), 'utf8')).toBe('one\ntwo\n')
      expect(existsSync(join(clone, 'id_rsa'))).toBe(false)
      // the sandbox itself is unchanged, its state still names the changes
      expect((await storage.state(key)).clean).toBe(false)
    })
  })
})
