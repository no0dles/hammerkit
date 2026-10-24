import { execFileSync } from 'child_process'
import { join } from 'path'
import { itExceptWindows, withSandboxServer } from '../testing/sandbox-server'
import {
  createPiOperations,
  hammerkitPiExtension,
  PiBashOperations,
  PiEditOperations,
  PiLibrary,
  PiToolDefinition,
} from './pi'

const root = join(process.cwd(), 'agent-work')
const at = (...parts: string[]) => join(root, ...parts)

describe('pi operations on a sandbox', () => {
  it('reads, writes and lists through the backends of pi tools', async () => {
    await withSandboxServer('harness-pi-files', async ({ client }) => {
      const ops = createPiOperations(async () => client, root)
      expect((await ops.read.readFile(at('input.txt'))).toString()).toBe('from-main\n')
      await ops.read.access(at('src', 'app.ts'))
      await expect(ops.read.access(at('missing.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(ops.read.readFile(join(root, '..', 'elsewhere.txt'))).rejects.toThrow(/outside of the sandbox/)
      expect(await ops.read.detectImageMimeType?.(at('logo.PNG'))).toBe('image/png')
      expect(await ops.read.detectImageMimeType?.(at('src', 'app.ts'))).toBeNull()

      // pi's write makes the directory first, the sandbox does that with the write
      await ops.write.mkdir(at('docs'))
      await ops.write.writeFile(at('docs', 'notes.md'), '# Notes\n')
      // pi's edit reads, replaces and writes back
      const before = (await ops.edit.readFile(at('src', 'app.ts'))).toString()
      await ops.edit.writeFile(at('src', 'app.ts'), before.replace('41', '42'))
      expect((await client.readRaw('src/app.ts')).toString()).toContain('answer = 42')

      expect(await ops.ls.exists(at('docs'))).toBe(true)
      expect((await ops.ls.stat(at('docs'))).isDirectory()).toBe(true)
      expect((await ops.ls.readdir(root)).sort()).toEqual(['docs', 'input.txt', 'src'])
      expect(await ops.find.glob('**/*.ts', root, { ignore: [], limit: 10 })).toEqual([at('src', 'app.ts')])

      const grep = await ops.grep({ pattern: 'ANSWER', ignoreCase: true, path: 'src' })
      expect(grep.content[0].text).toBe('src/app.ts:2: export const answer = 42')
      // pi's own grep takes `@src` for `src`
      expect((await ops.grep({ pattern: 'answer', path: '@src' })).content[0].text).toBe(
        'src/app.ts:2: export const answer = 42'
      )
    })
  })

  itExceptWindows('runs bash in the directory pi asks for and answers its exit code', async () => {
    await withSandboxServer('harness-pi-bash', async ({ client }) => {
      const ops = createPiOperations(async () => client, root)
      const chunks: string[] = []
      const ran = await ops.bash.exec('ls && exit 4', at('src'), {
        onData: (data) => chunks.push(data.toString()),
      })
      expect(ran).toEqual({ exitCode: 4 })
      expect(chunks.join('')).toBe('app.ts\n')
    })
  })
})

describe('pi extension', () => {
  it('swaps the backends of the tools pi has and says where the files are', async () => {
    await withSandboxServer('harness-pi-extension', async ({ client, environment }) => {
      const made: { [name: string]: { cwd: string; operations?: unknown } } = {}
      const tool = (name: string) => (cwd: string, options?: { operations?: unknown }) => {
        made[name] = { cwd, operations: options?.operations }
        return { name, parameters: { type: 'object' }, execute: async () => ({ content: [] }) }
      }
      const library: PiLibrary = {
        createReadToolDefinition: tool('read'),
        createWriteToolDefinition: tool('write'),
        createEditToolDefinition: tool('edit'),
        createBashToolDefinition: tool('bash'),
        createLsToolDefinition: tool('ls'),
        createFindToolDefinition: tool('find'),
        createGrepToolDefinition: tool('grep'),
      }
      const registered: PiToolDefinition[] = []
      const handlers: { [event: string]: (event: any, ctx: any) => any } = {}
      hammerkitPiExtension(library, {
        cwd: root,
        environment,
        options: { sandbox: client.id, build: client.build.hash },
      })({
        registerTool: (definition) => registered.push(definition),
        on: (event, handler) => (handlers[event] = handler),
      })
      expect(registered.map((definition) => definition.name)).toEqual([
        'read',
        'write',
        'edit',
        'bash',
        'ls',
        'find',
        'grep',
        'push',
      ])
      expect(made.read).toMatchObject({ cwd: root, operations: { readFile: expect.any(Function) } })
      expect(made.bash.operations).toMatchObject({ exec: expect.any(Function) })
      expect(handlers.user_bash({}, {})).toEqual({ operations: { exec: expect.any(Function) } })

      // the extension connects with the host config: no server is registered here
      const notified: string[] = []
      await handlers.session_start({}, { ui: { notify: (message: string) => notified.push(message) } })
      expect(notified[0]).toMatch(/hammerkit: name a server/)
      expect(await handlers.before_agent_start({ systemPrompt: 'x' }, {})).toBeUndefined()
    })
  })

  it('names the sandbox in the system prompt once it is connected', async () => {
    await withSandboxServer('harness-pi-prompt', async ({ client, repository }) => {
      const handlers: { [event: string]: (event: any, ctx: any) => any } = {}
      const tool = (name: string) => () => ({ name, parameters: {}, execute: async () => undefined })
      const library = {
        createReadToolDefinition: tool('read'),
        createWriteToolDefinition: tool('write'),
        createEditToolDefinition: tool('edit'),
        createBashToolDefinition: tool('bash'),
        createLsToolDefinition: tool('ls'),
        createFindToolDefinition: tool('find'),
        createGrepToolDefinition: tool('grep'),
      }
      const registered: PiToolDefinition[] = []
      const extension = hammerkitPiExtension(library, { cwd: root, client: async () => client })
      extension({
        registerTool: (definition) => registered.push(definition),
        on: (event, handler) => (handlers[event] = handler),
      })
      const status: string[] = []
      await handlers.session_start({}, { ui: { setStatus: (_key: string, text: string) => status.push(text) } })
      expect(status).toEqual([`hammerkit sandbox ${client.id}`])
      const prompt = await handlers.before_agent_start(
        { systemPrompt: `You are pi.\nCurrent working directory: ${root}\nBe brief.` },
        {}
      )
      expect(prompt.systemPrompt).toContain(
        `Current working directory: ${root}\nFiles and commands are on hammerkit sandbox ${client.id} of github.com/corp/payments`
      )
      expect(prompt.systemPrompt).toContain(
        `Commands run as the task sh of the published build file ${client.build.hash}`
      )
      expect(prompt.systemPrompt).toContain(`start in the root of the sandbox, where ${root} does not exist`)

      // push takes the work out as a branch the operator allows
      await client.writeRaw('notes.md', 'from pi\n')
      const push = registered.find((definition) => definition.name === 'push') as PiToolDefinition
      await expect(push.execute('call-1', { branch: 'main', message: 'Agent work' })).rejects.toThrow(
        /you may only push to agent\/\*\*/
      )
      const pushed = await push.execute('call-2', { branch: 'agent/pi-1', message: 'Agent work' })
      const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'agent/pi-1'], { encoding: 'utf8' }).trim()
      expect(pushed.content).toEqual([{ type: 'text', text: `pushed ${commit} to agent/pi-1` }])
    })
  })

  itExceptWindows('takes the tool calls of a turn one at a time, in the order pi made them', async () => {
    await withSandboxServer('harness-pi-turns', async ({ client }) => {
      // tools as pi makes them: bash runs a command, edit reads and writes the file back
      const library = {
        createReadToolDefinition: () => ({ name: 'read', parameters: {}, execute: async () => undefined }),
        createWriteToolDefinition: () => ({ name: 'write', parameters: {}, execute: async () => undefined }),
        createEditToolDefinition: (_cwd: string, options?: { operations?: PiEditOperations }) => ({
          name: 'edit',
          parameters: {},
          execute: async (_id: string, params: { path: string; oldText: string; newText: string }) => {
            const ops = options?.operations as PiEditOperations
            const text = (await ops.readFile(at(params.path))).toString()
            await ops.writeFile(at(params.path), text.replace(params.oldText, params.newText))
          },
        }),
        createBashToolDefinition: (_cwd: string, options?: { operations?: PiBashOperations }) => ({
          name: 'bash',
          parameters: {},
          execute: async (_id: string, params: { command: string }) => {
            const chunks: string[] = []
            await options?.operations?.exec(params.command, root, { onData: (data) => chunks.push(data.toString()) })
            return chunks.join('')
          },
        }),
        createLsToolDefinition: () => ({ name: 'ls', parameters: {}, execute: async () => undefined }),
        createFindToolDefinition: () => ({ name: 'find', parameters: {}, execute: async () => undefined }),
        createGrepToolDefinition: () => ({ name: 'grep', parameters: {}, execute: async () => undefined }),
      }
      const registered: { [name: string]: PiToolDefinition } = {}
      hammerkitPiExtension(library, { cwd: root, client: async () => client })({
        registerTool: (definition) => (registered[definition.name] = definition),
        on: () => undefined,
      })
      // the edit was refused while the command ran, and the tests ran on the old code
      const [shown] = await Promise.all([
        registered.bash.execute('call-1', { command: 'sleep 1; cat src/app.ts' }),
        registered.edit.execute('call-2', { path: 'src/app.ts', oldText: '41', newText: '42' }),
      ])
      expect(shown).toContain('answer = 41')
      const [, again] = await Promise.all([
        registered.edit.execute('call-3', { path: 'src/app.ts', oldText: '42', newText: '43' }),
        registered.bash.execute('call-4', { command: 'cat src/app.ts' }),
      ])
      expect(again).toContain('answer = 43')
    })
  })
})
