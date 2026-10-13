import { join } from 'path'
import { itExceptWindows, withSandboxServer } from '../testing/sandbox-server'
import { checkSandboxPath, exitCodeOf, quotePosix, SandboxClientError, toSandboxPath } from './sandbox-client'

describe('sandbox paths', () => {
  it('maps the working directory of a harness onto the root of the sandbox', () => {
    const root = join(process.cwd(), 'work')
    expect(toSandboxPath(root, join(root, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(toSandboxPath(root, root)).toBe('')
    expect(toSandboxPath(root, 'src/../lib/b.ts')).toBe('lib/b.ts')
    expect(() => toSandboxPath(root, join(root, '..', 'other'))).toThrow(/is outside of the sandbox/)
    expect(() => toSandboxPath(root, '../x')).toThrow(SandboxClientError)
  })

  it('takes relative paths below the root only', () => {
    expect(checkSandboxPath('./src/a.ts')).toBe('src/a.ts')
    expect(checkSandboxPath('src\\a.ts')).toBe('src/a.ts')
    expect(checkSandboxPath('.')).toBe('')
    expect(() => checkSandboxPath('/etc/passwd')).toThrow(/outside/)
    expect(() => checkSandboxPath('a/../../b')).toThrow(/outside/)
  })

  it('quotes a directory for the shell and reads the exit code of a result', () => {
    expect(quotePosix("it's here")).toBe(`'it'\\''s here'`)
    expect(exitCodeOf(undefined)).toBeNull()
    expect(exitCodeOf({ status: 'cached', lastLog: [] })).toBe(0)
    expect(exitCodeOf({ status: 'failed', exitCode: 2, lastLog: [] })).toBe(2)
    expect(exitCodeOf({ status: 'cancelled', lastLog: [] })).toBeNull()
  })
})

describe('sandbox client', () => {
  it('reads, writes, searches and edits the files of a sandbox', async () => {
    await withSandboxServer('harness-client-files', async ({ client }) => {
      expect(await client.stat('input.txt')).toMatchObject({ type: 'file', size: 10 })
      expect(await client.stat('missing.txt')).toBeUndefined()
      expect((await client.readRaw('input.txt')).toString()).toBe('from-main\n')
      await expect(client.readRaw('src')).rejects.toThrow(/src is a directory/)

      expect(await client.writeRaw('docs/new file.md', '# New\n')).toMatchObject({
        path: 'docs/new file.md',
        change: 'added',
      })
      expect((await client.read('docs/new file.md')).content).toBe('     1\t# New')
      const tree = await client.tree({ glob: '**/*.md' })
      expect(tree.entries.map((entry) => entry.path)).toEqual(['docs/new file.md'])

      await client.edit([{ op: 'replace', path: 'src/app.ts', old_string: '41', new_string: '42' }])
      const search = await client.search({ pattern: 'answer = \\d+', output_mode: 'content' })
      expect(search.matches).toEqual([{ path: 'src/app.ts', line: 2, text: 'export const answer = 42' }])
      await expect(
        client.edit([{ op: 'replace', path: 'src/app.ts', old_string: 'nothing', new_string: 'x' }])
      ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/old_string is not in src\/app\.ts/) })

      const changes = await client.changes()
      expect(changes.files.map((file) => `${file.status} ${file.path}`)).toEqual([
        'added docs/new file.md',
        'modified src/app.ts',
      ])
      expect(await client.diff('diff')).toContain('+export const answer = 42')
      await expect(client.read('../outside')).rejects.toThrow(/outside of the sandbox/)
    })
  })

  itExceptWindows('runs a shell command on the sandbox and follows its output to the exit code', async () => {
    await withSandboxServer('harness-client-exec', async ({ client }) => {
      const lines: string[] = []
      const ran = await client.exec('cat app.ts && echo "it\'s $((40 + 2))"', 'src', {
        onLine: (line) => lines.push(line),
      })
      expect(ran.exitCode).toBe(0)
      expect(ran.output).toContain('export const greeting = "hello"')
      expect(lines).toContain("it's 42")
      expect(ran.run.tasks).toEqual(['sh'])

      // what a command writes stays for the next one, and for the file API
      await client.exec('echo made > made.txt', '')
      expect((await client.readRaw('made.txt')).toString()).toBe('made\n')

      const failed = await client.exec('echo out; echo err >&2; exit 7', '')
      expect(failed.exitCode).toBe(7)
      expect(failed.output.split('\n')).toEqual(expect.arrayContaining(['out', 'err']))

      const task = await client.runTask('fail')
      expect(task.exitCode).toBe(3)
      expect(task.result?.lastLog).toContain('broken')
    })
  })
})
