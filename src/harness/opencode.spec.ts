import { join } from 'path'
import { z } from 'zod'
import { itExceptWindows, withSandboxServer } from '../testing/sandbox-server'
import { createOpencodeTools, hammerkitOpencodePlugin, OpencodeToolContext } from './opencode'

const directory = join(process.cwd(), 'agent-work')
const context = (): OpencodeToolContext => ({ directory, abort: new AbortController().signal })

describe('opencode tools on a sandbox', () => {
  it('takes the parameters of opencode and answers in its words', async () => {
    await withSandboxServer('harness-opencode-files', async ({ client }) => {
      const tools = createOpencodeTools(z, async () => client)
      expect(Object.keys(tools)).toEqual(['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'glob'])
      // opencode builds a zod object of the args, as it does for its own
      expect(z.object(tools.edit.args as z.ZodRawShape).safeParse({ filePath: 'a', oldString: 'x' }).success).toBe(
        false
      )

      const read = await tools.read.execute({ filePath: join(directory, 'src', 'app.ts'), limit: 1 }, context())
      expect(read).toBe(
        [
          `<path>${join(directory, 'src', 'app.ts')}</path>`,
          '<type>file</type>',
          '<content>',
          '1: export const greeting = "hello"',
          '',
          '(Showing lines 1-1 of 2. Use offset=2 to continue.)',
          '</content>',
        ].join('\n')
      )
      expect(await tools.read.execute({ filePath: directory }, context())).toContain('<entries>\ninput.txt\nsrc/\n')
      await expect(tools.read.execute({ filePath: join(directory, 'nope') }, context())).rejects.toThrow(
        /File not found/
      )

      const file = join(directory, 'src', 'app.ts')
      expect(await tools.edit.execute({ filePath: file, oldString: '41', newString: '42' }, context())).toBe(
        'Edit applied successfully.'
      )
      expect(await tools.write.execute({ filePath: join(directory, 'b.txt'), content: 'b\n' }, context())).toBe(
        'Wrote file successfully.'
      )
      const patched = await tools.apply_patch.execute(
        {
          patchText: [
            '*** Begin Patch',
            '*** Add File: docs/a.md',
            '+# A',
            '*** Delete File: b.txt',
            '*** End Patch',
          ].join('\n'),
        },
        context()
      )
      expect(patched).toBe('Success. Updated the following files:\nD b.txt\nA docs/a.md')

      const grep = await tools.grep.execute({ pattern: 'answer', include: '*.ts' }, context())
      expect(grep).toBe(`Found 1 matches\n\n${file}:\n  Line 2: export const answer = 42`)
      expect(await tools.glob.execute({ pattern: '**/*.md' }, context())).toBe(join(directory, 'docs', 'a.md'))
    })
  })

  itExceptWindows('runs bash in the workdir and adds the exit code when it failed', async () => {
    await withSandboxServer('harness-opencode-bash', async ({ client }) => {
      const tools = createOpencodeTools(z, async () => client)
      const ok = await tools.bash.execute({ command: 'cat app.ts', workdir: join(directory, 'src') }, context())
      expect(ok).toBe('export const greeting = "hello"\nexport const answer = 41')
      expect(await tools.bash.execute({ command: 'echo no >&2; exit 2' }, context())).toBe('no\n\nExit code: 2')
    })
  })

  it('connects lazily and says what is missing', async () => {
    await withSandboxServer('harness-opencode-plugin', async ({ environment }) => {
      const hooks = await hammerkitOpencodePlugin(z, { environment, options: { build: 'payments' } })({ directory })
      await expect(hooks.tool.read.execute({ filePath: join(directory, 'a') }, context())).rejects.toThrow(
        /name a server/
      )
    })
  })
})
