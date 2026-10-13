import { basename, extname, join } from 'path'
import { Environment } from '../executer/environment'
import { connectSandbox, getHarnessEnvironment, HarnessOptions, harnessOptionsFromEnv } from './connect'
import { formatSearch } from './format'
import { SandboxClient, toSandboxPath } from './sandbox-client'

// The parts of pi (`@earendil-works/pi-coding-agent`) this extension uses, as pi declares
// them. pi hands its own module to the extension, hammerkit does not depend on it.
export interface PiReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>
  access: (absolutePath: string) => Promise<void>
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>
}

export interface PiWriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>
  mkdir: (dir: string) => Promise<void>
}

export interface PiEditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>
  writeFile: (absolutePath: string, content: string) => Promise<void>
  access: (absolutePath: string) => Promise<void>
}

export interface PiBashOperations {
  exec: (
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }
  ) => Promise<{ exitCode: number | null }>
}

export interface PiLsOperations {
  exists: (absolutePath: string) => Promise<boolean>
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }>
  readdir: (absolutePath: string) => Promise<string[]>
}

export interface PiFindOperations {
  exists: (absolutePath: string) => Promise<boolean>
  glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]>
}

export interface PiToolDefinition {
  name: string
  parameters: unknown
  execute: (...args: any[]) => Promise<any>
  [key: string]: unknown
}

export interface PiLibrary {
  createReadToolDefinition(cwd: string, options?: { operations?: PiReadOperations }): PiToolDefinition
  createWriteToolDefinition(cwd: string, options?: { operations?: PiWriteOperations }): PiToolDefinition
  createEditToolDefinition(cwd: string, options?: { operations?: PiEditOperations }): PiToolDefinition
  createBashToolDefinition(cwd: string, options?: { operations?: PiBashOperations }): PiToolDefinition
  createLsToolDefinition(cwd: string, options?: { operations?: PiLsOperations }): PiToolDefinition
  createFindToolDefinition(cwd: string, options?: { operations?: PiFindOperations }): PiToolDefinition
  createGrepToolDefinition(cwd: string): PiToolDefinition
}

export interface PiExtensionApi {
  registerTool(tool: PiToolDefinition): void
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown
}

export interface PiGrepParams {
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
}

const IMAGE_TYPES: { [extension: string]: string } = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

// a listing is read in pages of this many entries, up to the most a directory answers
const PAGE = 1000
const MAX_ENTRIES = 20_000

function notFound(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' })
}

/**
 * The backends of pi's own tools on a hammerkit sandbox. pi resolves every path against its
 * working directory (`root`), which stands for the root of the sandbox. The model keeps
 * pi's tools, their parameters and their output; only where they read, write and run moves.
 */
export function createPiOperations(client: () => Promise<SandboxClient>, root: string) {
  const path = (absolute: string) => toSandboxPath(root, absolute)
  const stat = async (absolute: string) => (await client()).stat(path(absolute))
  const readFile = async (absolute: string) => (await client()).readRaw(path(absolute))
  const writeFile = async (absolute: string, content: string) => {
    await (await client()).writeRaw(path(absolute), content)
  }
  const accessFile = async (absolute: string) => {
    const found = await stat(absolute)
    if (!found) {
      throw notFound(absolute)
    }
  }
  const exists = async (absolute: string) => (await stat(absolute)) !== undefined

  const read: PiReadOperations = {
    readFile,
    access: accessFile,
    detectImageMimeType: async (absolute) => IMAGE_TYPES[extname(absolute).toLowerCase()] ?? null,
  }
  // a write makes the directories it needs
  const write: PiWriteOperations = { writeFile, mkdir: async () => undefined }
  const edit: PiEditOperations = { readFile, writeFile, access: accessFile }

  const bash: PiBashOperations = {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const sandbox = await client()
      const ran = await sandbox.exec(command, path(cwd), {
        signal,
        timeoutSeconds: timeout,
        onLine: (line) => onData(Buffer.from(`${line}\n`)),
        onWaiting: (run) =>
          onData(Buffer.from(`hammerkit: run ${run.id} waits for an approval of ${run.accounts.join(', ')}\n`)),
      })
      if (signal?.aborted) {
        throw new Error('aborted')
      }
      if (timeout && ran.result?.error?.startsWith('timed out')) {
        throw new Error(`timeout:${timeout}`)
      }
      if (ran.exitCode === null) {
        // the task never ran or ended without an exit code: say why
        const why = ran.result?.error ?? ran.run.error ?? `the run ended ${ran.run.state}`
        onData(Buffer.from(`hammerkit: ${why}\n`))
      }
      return { exitCode: ran.exitCode }
    },
  }

  const ls: PiLsOperations = {
    exists,
    stat: async (absolute) => {
      const found = await stat(absolute)
      if (!found) {
        throw notFound(absolute)
      }
      return { isDirectory: () => found.type === 'directory' }
    },
    readdir: async (absolute) => {
      const sandbox = await client()
      const directory = path(absolute)
      const names: string[] = []
      let cursor: string | undefined
      do {
        const page = await sandbox.tree({ path: directory || undefined, depth: 1, limit: PAGE, cursor })
        names.push(...page.entries.map((entry) => basename(entry.path)))
        cursor = page.cursor ?? undefined
      } while (cursor && names.length < MAX_ENTRIES)
      return names
    },
  }

  const find: PiFindOperations = {
    exists,
    glob: async (pattern, cwd, { limit }) => {
      const sandbox = await client()
      const directory = path(cwd)
      // as pi's own find (fd): a pattern matches at any depth below the directory
      const anywhere = pattern === '**' || pattern.startsWith('**/') || pattern.startsWith('/')
      const page = await sandbox.tree({
        path: directory || undefined,
        glob: anywhere ? pattern.replace(/^\/+/, '') : `**/${pattern}`,
        limit: Math.min(Math.max(limit, 1), MAX_ENTRIES),
      })
      return page.entries.map((entry) => join(root, ...entry.path.split('/')))
    },
  }

  // pi's grep runs ripgrep on the machine; this one runs it on the server
  const grep = async (params: PiGrepParams) => {
    const sandbox = await client()
    const result = await sandbox.search({
      pattern: params.pattern,
      // pi takes `@src` for `src`, as its own grep does
      path: params.path ? path(params.path.replace(/^@/, '')) || undefined : undefined,
      glob: params.glob ? [params.glob] : undefined,
      i: params.ignoreCase,
      fixed_strings: params.literal,
      C: params.context,
      output_mode: 'content',
      head_limit: params.limit ?? 100,
    })
    return { content: [{ type: 'text', text: formatSearch(result) }], details: undefined }
  }

  return { read, write, edit, bash, ls, find, grep }
}

export interface PiExtensionOptions {
  options?: HarnessOptions
  environment?: Environment
  // the working directory pi resolves paths against, the root of the sandbox
  cwd?: string
  // a sandbox already connected, instead of the one the options name
  client?: () => Promise<SandboxClient>
}

/**
 * The pi extension: pi's read, write, edit, bash, ls, find and grep tools, and the user's
 * `!` commands, work on a hammerkit sandbox. Configured with the same variables as
 * `hammerkit remote mcp` takes options: HAMMERKIT_SERVER, HAMMERKIT_SANDBOX (or HAMMERKIT_REPO and
 * HAMMERKIT_REF), HAMMERKIT_BUILD and HAMMERKIT_SHELL.
 */
export function hammerkitPiExtension(library: PiLibrary, settings: PiExtensionOptions = {}) {
  return (pi: PiExtensionApi): void => {
    const root = settings.cwd ?? process.cwd()
    const environment = settings.environment ?? getHarnessEnvironment(root)
    const options = settings.options ?? harnessOptionsFromEnv(environment.processEnvs)
    const notes: string[] = []
    let connecting: Promise<SandboxClient> | undefined
    const client = () => {
      if (!connecting) {
        connecting = settings.client
          ? settings.client()
          : connectSandbox(environment, options, (line) => notes.push(line))
        // a failure is said by the call that needed it, the next one tries again
        connecting.catch(() => (connecting = undefined))
      }
      return connecting
    }

    const ops = createPiOperations(client, root)
    pi.registerTool(library.createReadToolDefinition(root, { operations: ops.read }))
    pi.registerTool(library.createWriteToolDefinition(root, { operations: ops.write }))
    pi.registerTool(library.createEditToolDefinition(root, { operations: ops.edit }))
    pi.registerTool(library.createBashToolDefinition(root, { operations: ops.bash }))
    pi.registerTool(library.createLsToolDefinition(root, { operations: ops.ls }))
    pi.registerTool(library.createFindToolDefinition(root, { operations: ops.find }))
    const grep = library.createGrepToolDefinition(root)
    pi.registerTool({ ...grep, execute: (_id: string, params: PiGrepParams) => ops.grep(params) })

    pi.on('session_start', async (_event, ctx) => {
      try {
        const sandbox = await client()
        ctx?.ui?.setStatus?.('hammerkit', `hammerkit sandbox ${sandbox.id}`)
        for (const note of notes.splice(0)) {
          ctx?.ui?.notify?.(note, 'info')
        }
      } catch (e) {
        ctx?.ui?.notify?.(`hammerkit: ${e instanceof Error ? e.message : String(e)}`, 'error')
      }
    })

    pi.on('user_bash', () => ({ operations: ops.bash }))

    pi.on('before_agent_start', async (event) => {
      let sandbox: SandboxClient
      try {
        sandbox = await client()
      } catch {
        return undefined
      }
      const where =
        `Files and commands are on hammerkit sandbox ${sandbox.id} of ${sandbox.sandbox.repo} ` +
        `(fetched at ${sandbox.sandbox.commit}), ${root} is its root. Commands run as the task ` +
        `${sandbox.build.shell} of the published build file ${sandbox.build.name}, in its container, ` +
        'one at a time; nothing is installed on this machine.'
      const line = `Current working directory: ${root}`
      const prompt: string = event.systemPrompt
      return {
        systemPrompt: prompt.includes(line) ? prompt.replace(line, `${line}\n${where}`) : `${prompt}\n\n${where}`,
      }
    })
  }
}
