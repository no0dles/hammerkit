import { execFileSync } from 'child_process'
import { join } from 'path'
import { z } from 'zod'
import { itExceptWindows, withSandboxServer } from '../testing/sandbox-server'
import {
  createOpencodeTools,
  createOpencodeV2Tools,
  hammerkitOpencodeEntry,
  hammerkitOpencodeV2Plugin,
  loadHammerkitOpencodePlugin,
  OPENCODE_TOOLS,
  OPENCODE_V2_LOCAL_TOOLS,
  OPENCODE_V2_TOOLS,
  OpencodeToolContext,
  OpencodeV2Tool,
  patchToSandbox,
} from './opencode'

const directory = join(process.cwd(), 'agent-work')
const context = (): OpencodeToolContext => ({ directory, abort: new AbortController().signal })
const v2 = () => ({ signal: new AbortController().signal })

describe('opencode tools on a sandbox', () => {
  it('takes the parameters of opencode and answers in its words', async () => {
    await withSandboxServer('harness-opencode-files', async ({ client, repository }) => {
      const tools = createOpencodeTools(z, async () => client)
      expect(Object.keys(tools)).toEqual([
        'read',
        'write',
        'edit',
        'apply_patch',
        'bash',
        'grep',
        'glob',
        'run_task',
        'run_logs',
        'check',
        'push',
        'list',
        'services_up',
        'endpoint_get',
        'services_stop',
      ])
      expect(OPENCODE_TOOLS).toEqual(Object.keys(tools))
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
      expect(await tools.list.execute({}, context())).toBe(
        [`${directory}/`, '  docs/', '    a.md', '  input.txt', '  src/', '    app.ts'].join('\n')
      )
      expect(await tools.list.execute({ path: join(directory, 'src'), ignore: ['*.ts'] }, context())).toBe(
        `${join(directory, 'src')}/`
      )

      await expect(tools.push.execute({ branch: 'main', message: 'Agent work' }, context())).rejects.toThrow(
        /you may only push to agent\/\*\*/
      )
      const pushed = await tools.push.execute({ branch: 'agent/opencode-1', message: 'Agent work' }, context())
      const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'agent/opencode-1'], {
        encoding: 'utf8',
      }).trim()
      expect(pushed).toEqual({ title: 'pushed to agent/opencode-1', output: `pushed ${commit} to agent/opencode-1` })
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

  itExceptWindows('takes the calls of a step in turns, in the order opencode made them', async () => {
    await withSandboxServer('harness-opencode-turns', async ({ client }) => {
      const tools = createOpencodeTools(z, async () => client)
      const patch = (from: string, to: string) => ({
        // GPT models name the file by the absolute path opencode shows them
        patchText: [
          '*** Begin Patch',
          `*** Update File: ${join(directory, 'src', 'app.ts')}`,
          '@@',
          `-export const answer = ${from}`,
          `+export const answer = ${to}`,
          '*** End Patch',
        ].join('\n'),
      })
      // a patch sent along with a command: the server refuses edits while the command runs
      const [shown, patched] = await Promise.all([
        tools.bash.execute({ command: 'sleep 1; cat src/app.ts' }, context()),
        tools.apply_patch.execute(patch('41', '42'), context()),
      ])
      expect(shown).toContain('answer = 41')
      expect(patched).toBe('Success. Updated the following files:\nM src/app.ts')
      const [, again] = await Promise.all([
        tools.apply_patch.execute(patch('42', '43'), context()),
        tools.bash.execute({ command: 'cat src/app.ts' }, context()),
      ])
      expect(again).toContain('answer = 43')

      // run_task takes its turn too: a write sent before it lands before the task starts, one
      // sent after it waits for the task to end instead of being refused by the held sandbox
      const done: string[] = []
      const track = <T>(name: string, call: Promise<T>) =>
        call.then((value) => {
          done.push(name)
          return value
        })
      const turn = (content: string) => ({ filePath: join(directory, 'turn.txt'), content })
      const [, ran, written] = await Promise.all([
        track('write', tools.write.execute(turn('first\n'), context())),
        track('run_task', tools.run_task.execute({ task: 'sh', args: ['sleep 1; cat turn.txt'] }, context())),
        track('write again', tools.write.execute(turn('second\n'), context())),
      ])
      expect(done).toEqual(['write', 'run_task', 'write again'])
      expect((ran as { output: string }).output).toContain('last lines:\nfirst\n')
      expect(written).toBe('Wrote file successfully.')
      expect((await client.readRaw('turn.txt')).toString()).toBe('second\n')
    })
  })

  itExceptWindows('runs the tasks of the build file without a shell, and reads their logs', async () => {
    await withSandboxServer('harness-opencode-tasks', async ({ client, repository }) => {
      const tools = createOpencodeTools(z, async () => client, { tasks: await client.tasks(), shell: '' })
      expect(Object.keys(tools)).toEqual(OPENCODE_TOOLS)
      // opencode's own bash would run on this machine, the plugin's stands in and refuses
      await expect(tools.bash.execute({ command: 'ls' }, context())).rejects.toThrow(/There is no shell/)
      expect(tools.bash.description).toMatch(/run the tasks of the build file with run_task/)
      // the model knows what it can run
      expect(tools.run_task.description.split('\n\n')[1]).toBe(
        [
          'The tasks of the published build file:',
          `- elsewhere: runs \`sh -c 'cd "$(mktemp -d)" && exec sh -c "$1"' sh\` (takes args)`,
          "- fail: runs `sh -c 'echo broken >&2; exit 3'` (takes no args)",
          '- long: print 300 lines (takes args)',
          '- sh: runs `sh -c` (takes args)',
          '- test: run the tests (takes args)',
        ].join('\n')
      )
      expect(z.object(tools.run_task.args as z.ZodRawShape).safeParse({ task: 'test', args: ['x'] }).success).toBe(true)

      await tools.write.execute({ filePath: join(directory, 'notes.md'), content: 'agent\n' }, context())
      const tested = await tools.run_task.execute({ task: 'test', args: ['--grep', 'login'] }, context())
      expect(tested).toEqual({ title: 'run test', output: expect.stringMatching(/^run run_[\w-]+: succeeded\n/) })
      const output = (tested as { output: string }).output
      expect(output).toMatch(/\ntask test: succeeded, \d+ ms\n/)
      expect(output).toContain('last lines:\ntesting --grep login\n')
      expect(output).toMatch(/read more of the log with run_logs \{ "run": "run_[\w-]+", "task": "test" \}$/)

      await expect(tools.run_task.execute({ task: 'fail', args: ['x'] }, context())).rejects.toThrow(
        /fail takes no arguments/
      )

      // a long log: the result ends with the last lines, run_logs reads the rest
      const long = (await tools.run_task.execute({ task: 'long' }, context())) as { output: string }
      expect(long.output).toContain('\n281\n')
      expect(long.output).not.toContain('\n280\n')
      const run = /^run (run_[\w-]+)/.exec(long.output)?.[1]
      expect(await tools.run_logs.execute({ run, task: 'long', from: 100, limit: 3 }, context())).toEqual({
        title: `log of ${run}`,
        output: '100: 100\n101: 101\n102: 102\n\n(300 lines, read on with from 103)',
      })
      const grep = (await tools.run_logs.execute({ run, task: 'long', grep: '250', context: 1 }, context())) as {
        output: string
      }
      expect(grep.output).toBe('249- 249\n250: 250\n251- 251\n\n(300 lines searched, 1 match here)')

      const pushed = await tools.push.execute({ branch: 'agent/tasks', message: 'Agent work' }, context())
      expect(pushed).toMatchObject({ title: 'pushed to agent/tasks' })
      expect(execFileSync('git', ['-C', repository, 'show', 'agent/tasks:notes.md'], { encoding: 'utf8' })).toBe(
        'agent\n'
      )
    })
  })

  it('maps the absolute paths of a patch onto the sandbox, and its lines not', () => {
    const patch = [
      '*** Begin Patch',
      `*** Update File: ${join(directory, 'src', 'a.ts')}\r`,
      `*** Move to: ${join(directory, 'b.ts')}`,
      `+*** Add File: ${join(directory, 'c.ts')}`,
      '*** Add File: docs/d.md',
      '*** End Patch',
    ].join('\n')
    expect(patchToSandbox(directory, patch)).toBe(
      [
        '*** Begin Patch',
        '*** Update File: src/a.ts\r',
        '*** Move to: b.ts',
        `+*** Add File: ${join(directory, 'c.ts')}`,
        '*** Add File: docs/d.md',
        '*** End Patch',
      ].join('\n')
    )
    expect(() => patchToSandbox(directory, `*** Delete File: ${join(directory, '..', 'x')}`)).toThrow(
      /outside of the sandbox/
    )
  })

  it('refuses with its tools when the zod of opencode does not load, so none of opencode works locally', async () => {
    const hooks = await loadHammerkitOpencodePlugin(async (specifier) => {
      throw new Error(`Cannot find module '${specifier}'`)
    })({ directory })
    expect(Object.keys(hooks.tool)).toEqual(OPENCODE_TOOLS)
    await expect(hooks.tool.bash.execute({ command: 'pwd' }, context())).rejects.toThrow(
      /could not load @opencode-ai\/plugin \(Cannot find module '@opencode-ai\/plugin'\), so its tools refuse/
    )
  })

  it('connects lazily and says what is missing', async () => {
    await withSandboxServer('harness-opencode-plugin', async ({ environment, build }) => {
      const hooks = await loadHammerkitOpencodePlugin(
        async (specifier) => {
          expect(specifier).toBe('@opencode-ai/plugin')
          return { tool: { schema: z } }
        },
        { environment, options: { build } }
      )({ directory })
      await expect(hooks.tool.read.execute({ filePath: join(directory, 'a') }, context())).rejects.toThrow(
        /name a server/
      )
    })
  })
})

describe('opencode 2 tools on a sandbox', () => {
  it('takes the inputs of opencode 2, with paths relative to the project or absolute', async () => {
    await withSandboxServer('harness-opencode2-files', async ({ client, repository }) => {
      const list = createOpencodeV2Tools(async () => client, directory)
      expect(list.map((tool) => tool.name)).toEqual(OPENCODE_V2_TOOLS)
      for (const tool of list) {
        expect(tool.options.codemode).toBe(false)
        expect(tool.input).toMatchObject({ type: 'object', additionalProperties: false })
      }
      const tools = Object.fromEntries(list.map((tool) => [tool.name, tool]))
      expect(tools.edit.options.permission).toBe('edit')

      expect((await tools.read.execute({ path: 'src/app.ts', limit: 1 }, v2())).content).toContain(
        '1: export const greeting = "hello"'
      )
      expect((await tools.read.execute({ path: directory }, v2())).content).toContain('<entries>\ninput.txt\nsrc/\n')
      await expect(tools.read.execute({ path: 'nope' }, v2())).rejects.toThrow(/File not found: nope/)
      expect(
        await tools.edit.execute({ path: join(directory, 'src', 'app.ts'), oldString: '41', newString: '42' }, v2())
      ).toEqual({ content: 'Edit applied successfully.' })
      expect(await tools.write.execute({ path: 'b.txt', content: 'b\n' }, v2())).toEqual({
        content: 'Wrote file successfully.',
      })
      const patched = await tools.patch.execute(
        { patchText: ['*** Begin Patch', '*** Delete File: b.txt', '*** End Patch'].join('\n') },
        v2()
      )
      expect(patched.content).toBe('Success. Updated the following files:\nD b.txt')

      const grep = await tools.grep.execute({ pattern: 'ANSWER = 42', literal: true, caseSensitive: false }, v2())
      expect(grep.content).toContain('Line 2: export const answer = 42')
      expect((await tools.grep.execute({ pattern: 'answer = 4.', literal: true }, v2())).content).toBe('No files found')
      expect((await tools.glob.execute({ pattern: '**/*.ts', path: 'src' }, v2())).content).toBe(
        join(directory, 'src', 'app.ts')
      )

      const pushed = await tools.push.execute({ branch: 'agent/opencode-2', message: 'Agent work' }, v2())
      const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'agent/opencode-2'], {
        encoding: 'utf8',
      }).trim()
      expect(pushed).toEqual({ content: `pushed ${commit} to agent/opencode-2` })
    })
  })

  itExceptWindows('runs shell commands in the workdir, with the default timeout for 0', async () => {
    await withSandboxServer('harness-opencode2-shell', async ({ client }) => {
      const shell = createOpencodeV2Tools(async () => client, directory).find((tool) => tool.name === 'shell')!
      expect(await shell.execute({ command: 'cat app.ts', workdir: 'src', timeout: 0 }, v2())).toEqual({
        content: 'export const greeting = "hello"\nexport const answer = 41',
      })
    })
  })

  it('sets itself up in place of the tools of opencode 2, and serves opencode 1 as well', async () => {
    await withSandboxServer('harness-opencode2-plugin', async ({ environment, build }) => {
      const plugin = hammerkitOpencodeEntry(async () => ({ tool: { schema: z } }), {
        environment,
        options: { build },
      })
      expect(plugin.id).toBe('hammerkit')
      const added: OpencodeV2Tool[] = []
      const removed: string[] = []
      const sessionHooks: { [name: string]: (input: { tools: { [name: string]: { description: string } } }) => void } =
        {}
      await plugin.setup({
        location: { directory },
        tool: {
          async transform(edit) {
            edit({ add: (tool) => added.push(tool), remove: (id) => removed.push(id) })
          },
        },
        session: {
          async hook(name, callback) {
            sessionHooks[name] = callback
          },
        },
      })
      expect(added.map((tool) => tool.name)).toEqual(OPENCODE_V2_TOOLS)
      expect(removed).toEqual(OPENCODE_V2_LOCAL_TOOLS)
      // opencode's own description of the shell, which it sets for each request, gives way to the plugin's
      expect(Object.keys(sessionHooks)).toEqual(['context', 'compaction', 'generate'])
      const request = {
        tools: { shell: { description: 'Commands run on Linux using bash.' }, read: { description: 'r' } },
      }
      sessionHooks.generate(request)
      expect(request.tools.shell.description).toContain('Run a shell command on the hammerkit sandbox')
      expect(request.tools.read.description).toBe('r')
      // it connects on the first call
      await expect(added[0].execute({ path: 'a' }, v2())).rejects.toThrow(/name a server/)
      // a plugin that can not list the tasks still loads, and says why they are missing
      expect(added.find((tool) => tool.name === 'run_task')!.description).toMatch(
        /The tasks of the build file could not be listed \(name a server/
      )

      const hooks = await plugin.server({ directory })
      expect(Object.keys(hooks.tool)).toEqual(OPENCODE_TOOLS)
    })
  })

  itExceptWindows('leaves out the shell without a shell task, and runs the tasks of the build file', async () => {
    await withSandboxServer('harness-opencode2-tasks', async ({ client, build }) => {
      const plugin = hammerkitOpencodeV2Plugin({ client: async () => client, options: { build, shell: '' } })
      const added: OpencodeV2Tool[] = []
      const removed: string[] = []
      const hooked: string[] = []
      await plugin.setup({
        location: { directory },
        tool: {
          async transform(edit) {
            edit({ add: (tool) => added.push(tool), remove: (id) => removed.push(id) })
          },
        },
        session: {
          async hook(name) {
            hooked.push(name)
          },
        },
      })
      expect(added.map((tool) => tool.name)).toEqual(OPENCODE_V2_TOOLS.filter((name) => name !== 'shell'))
      // opencode's own shell would run on this machine
      expect(removed).toEqual([...OPENCODE_V2_LOCAL_TOOLS, 'shell'])
      expect(hooked).toEqual([])
      const tools = Object.fromEntries(added.map((tool) => [tool.name, tool]))
      expect(tools.run_task.description).toContain('- test: run the tests (takes args)')
      expect(tools.run_task.input).toMatchObject({ required: ['task'], additionalProperties: false })
      const ran = await tools.run_task.execute({ task: 'test', args: ['a.spec.ts'] }, v2())
      expect(ran.content).toContain('last lines:\ntesting a.spec.ts\n')
      const run = /^run (run_[\w-]+)/.exec(ran.content)?.[1]
      expect((await tools.run_logs.execute({ run, task: 'test', tail: 1 }, v2())).content).toBe(
        '1: testing a.spec.ts\n\n(1 lines)'
      )
    })
  })
})
