import { join } from 'path'
import { itExceptWindows, withSandboxServer } from '../testing/sandbox-server'
import { createPiOperations, hammerkitPiExtension, PiLibrary, PiToolDefinition } from './pi'

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
        options: { sandbox: client.id, build: 'payments' },
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
      ])
      expect(made.read).toMatchObject({ cwd: root, operations: { readFile: expect.any(Function) } })
      expect(made.bash.operations).toMatchObject({ exec: expect.any(Function) })
      expect(handlers.user_bash({}, {})).toEqual({ operations: made.bash.operations })

      // the extension connects with the host config: no server is registered here
      const notified: string[] = []
      await handlers.session_start({}, { ui: { notify: (message: string) => notified.push(message) } })
      expect(notified[0]).toMatch(/hammerkit: name a server/)
      expect(await handlers.before_agent_start({ systemPrompt: 'x' }, {})).toBeUndefined()
    })
  })

  it('names the sandbox in the system prompt once it is connected', async () => {
    await withSandboxServer('harness-pi-prompt', async ({ client }) => {
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
      const extension = hammerkitPiExtension(library, { cwd: root, client: async () => client })
      extension({ registerTool: () => undefined, on: (event, handler) => (handlers[event] = handler) })
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
      expect(prompt.systemPrompt).toContain('Commands run as the task sh of the published build file payments')
    })
  })
})
