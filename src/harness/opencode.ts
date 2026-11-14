import { existsSync, readFileSync } from 'fs'
import { Minimatch } from 'minimatch'
import { homedir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import { pathToFileURL } from 'url'
import { Environment } from '../executer/environment'
import {
  connectSandbox,
  connectServer,
  DEFAULT_SHELL_TASK,
  getHarnessEnvironment,
  HarnessOptions,
  harnessOptionsFromEnv,
} from './connect'
import { capOutput, formatTree, toColonNumbers } from './format'
import { listPublishedTasks, oneAtATime, SandboxClient, toSandboxPath } from './sandbox-client'
import { createTaskTools, readLogHint, readTaskListing, TaskListing, taskToolArgs, taskToolSchema } from './task-tools'
import { SERVICE_TOOLS, serviceToolArgs, serviceToolSchema } from './service-tools'

// What opencode passes a tool (`ToolContext` of `@opencode-ai/plugin`), the parts used here.
export interface OpencodeToolContext {
  directory: string
  abort: AbortSignal
  metadata?(input: { title?: string; metadata?: { [key: string]: unknown } }): void
}

export interface OpencodeTool {
  description: string
  args: { [name: string]: unknown }
  execute(args: any, context: OpencodeToolContext): Promise<string | { title?: string; output: string }>
}

export interface OpencodeHooks {
  tool: { [name: string]: OpencodeTool }
}

export type OpencodePlugin = (input: { directory: string; worktree?: string }) => Promise<OpencodeHooks>

export interface OpencodePluginOptions {
  options?: HarnessOptions
  environment?: Environment
  // a sandbox already connected, instead of the one the options name
  client?: () => Promise<SandboxClient>
}

const DEFAULT_READ_LINES = 2000
const LIST_LIMIT = 100
const SEARCH_LIMIT = 100

// the parameters of grep, of opencode 1 and the ones opencode 2 added
interface GrepArgs {
  pattern: string
  path?: string
  include?: string
  literal?: boolean
  caseSensitive?: boolean
  limit?: number
}

/**
 * The tools of opencode on a hammerkit sandbox: `read`, `write`, `edit`, `apply_patch`,
 * `bash`, `grep`, `glob` and `list` with the parameters of opencode's own, which a plugin replaces
 * by registering tools of the same name, `run_task` and `run_logs` for the tasks of the build
 * file, and `push`, which takes the work out as a branch. opencode resolves paths against its
 * directory, which stands for the root of the sandbox. `schema` is the zod of opencode
 * (`tool.schema` of `@opencode-ai/plugin`), so it reads the parameters as its own.
 */
export function hammerkitOpencodePlugin(schema: any, settings: OpencodePluginOptions = {}): OpencodePlugin {
  return async (input) => {
    const harness = connectHarness(input.directory, settings)
    const tasks = await harness.tasks()
    return { tool: createOpencodeTools(schema, harness.client, { tasks, shell: harness.shell }) }
  }
}

interface Harness {
  // the sandbox, connected on the first call of a tool and again after a failed connect
  client: () => Promise<SandboxClient>
  // the tasks of the published version, for the description of run_task
  tasks: () => Promise<TaskListing>
  // the shell task, '' for none
  shell: string
}

function connectHarness(directory: string, settings: OpencodePluginOptions): Harness {
  const environment = settings.environment ?? getHarnessEnvironment(directory)
  const options = settings.options ?? harnessOptionsFromEnv(environment.processEnvs)
  let connecting: Promise<SandboxClient> | undefined
  const client = () => {
    if (!connecting) {
      connecting = settings.client ? settings.client() : connectSandbox(environment, options)
      connecting.catch(() => (connecting = undefined))
    }
    return connecting
  }
  return {
    client,
    // the version is read without a sandbox, which the first call of a tool takes
    tasks: () =>
      readTaskListing(async () => {
        if (settings.client) {
          return (await client()).tasks()
        }
        const server = await connectServer(environment, options)
        return listPublishedTasks(server.connection, server.build)
      }),
    shell: options.shell ?? DEFAULT_SHELL_TASK,
  }
}

// the names of the tools of the plugin, which stand in for opencode's own
export const OPENCODE_TOOLS = [
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
]

/**
 * The plugin as the file `harness/opencode.ts` exports it: it takes the zod of opencode from
 * `@opencode-ai/plugin`, found next to hammerkit or else in the opencode directories of the
 * project and of the user, as a linked hammerkit does not see the packages of the project.
 * Without it the tools still stand in for opencode's and refuse: opencode carries on without a
 * plugin that fails, and its own tools would work on this machine. `load` is `import` of the file.
 */
export function loadHammerkitOpencodePlugin(
  load: (specifier: string) => Promise<any>,
  settings: OpencodePluginOptions = {}
): OpencodePlugin {
  return async (input) => {
    let schema: unknown
    let failure: unknown
    for (const specifier of ['@opencode-ai/plugin', ...opencodePluginFiles(input)]) {
      try {
        schema = (await load(specifier)).tool.schema
        break
      } catch (e) {
        failure = failure ?? e
      }
    }
    if (schema) {
      return hammerkitOpencodePlugin(schema, settings)(input)
    }
    const message =
      `hammerkit's opencode plugin could not load @opencode-ai/plugin ` +
      `(${failure instanceof Error ? failure.message : String(failure)}), so its tools refuse rather than ` +
      'work on this machine: add "@opencode-ai/plugin" to the dependencies of .opencode/package.json'
    const refusing: OpencodeTool = {
      description: message,
      args: {},
      async execute() {
        throw new Error(message)
      },
    }
    return { tool: Object.fromEntries(OPENCODE_TOOLS.map((name) => [name, refusing])) }
  }
}

// the entry of @opencode-ai/plugin in the opencode directories of the project and of the user
function opencodePluginFiles(input: { directory: string; worktree?: string }): string[] {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const directories = [input.directory, input.worktree, join(config, 'opencode')]
    .filter((directory): directory is string => !!directory)
    .flatMap((directory) => [join(directory, '.opencode'), directory])
  const files: string[] = []
  for (const directory of directories) {
    for (let current = directory; ; current = dirname(current)) {
      const manifest = join(current, 'node_modules', '@opencode-ai', 'plugin', 'package.json')
      if (existsSync(manifest)) {
        const entry = packageEntry(manifest)
        if (entry && !files.includes(entry)) {
          files.push(entry)
        }
        break
      }
      if (dirname(current) === current) {
        break
      }
    }
  }
  return files.map((file) => pathToFileURL(file).href)
}

function packageEntry(manifest: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const root = typeof pkg.exports === 'object' ? pkg.exports['.'] ?? pkg.exports : pkg.exports
    const entry = typeof root === 'string' ? root : root?.import ?? root?.default ?? pkg.module ?? pkg.main
    return typeof entry === 'string' ? join(dirname(manifest), entry) : undefined
  } catch {
    return undefined
  }
}

// What opencode 2 passes a tool besides its input, the parts used here
export interface OpencodeV2ToolContext {
  signal: AbortSignal
}

// a tool of the plugin API of opencode 2 (`Tool.Info` of `@opencode/plugin`), its input a JSON schema
export interface OpencodeV2Tool {
  name: string
  description: string
  input: { [key: string]: unknown }
  options: { codemode: false; permission?: string }
  execute(input: any, context: OpencodeV2ToolContext): Promise<{ content: string }>
}

export interface OpencodeV2ToolEditor {
  add(tool: OpencodeV2Tool): void
  remove(id: string): void
}

// What opencode 2 passes the setup of a plugin (`Context` of `@opencode/plugin`), the parts used here
export interface OpencodeV2Context {
  location: { directory: string }
  tool: { transform(edit: (editor: OpencodeV2ToolEditor) => void): Promise<unknown> }
  session: {
    hook(
      name: 'context' | 'compaction' | 'generate',
      callback: (input: { tools: { [name: string]: { description: string } } }) => void
    ): Promise<unknown>
  }
}

export interface OpencodeV2Plugin {
  id: string
  setup(context: OpencodeV2Context): Promise<void>
}

// the names of the tools of the plugin on opencode 2, which stand in for its own
export const OPENCODE_V2_TOOLS = [
  'read',
  'write',
  'edit',
  'patch',
  'shell',
  'glob',
  'grep',
  'run_task',
  'run_logs',
  'check',
  'push',
  'services_up',
  'endpoint_get',
  'services_stop',
]

// the tools of opencode 2 that work on this machine and have no stand-in on a sandbox
export const OPENCODE_V2_LOCAL_TOOLS = [
  'opencode_worktree_create',
  'opencode_worktree_list',
  'opencode_worktree_remove',
]

/**
 * The plugin for opencode 2: the tools of {@link createOpencodeV2Tools} in place of opencode's own,
 * and none of the worktree tools, which would make worktrees of this machine, nor its shell
 * when there is no shell task. opencode 2 takes a plugin as an object with an id and a setup, it
 * needs no package of opencode.
 */
export function hammerkitOpencodeV2Plugin(settings: OpencodePluginOptions = {}): OpencodeV2Plugin {
  return {
    id: 'hammerkit',
    async setup(context) {
      const directory = context.location.directory
      const harness = connectHarness(directory, settings)
      const tasks = await harness.tasks()
      const tools = createOpencodeV2Tools(harness.client, directory, { tasks, shell: harness.shell })
      await context.tool.transform((editor) => {
        for (const tool of tools) {
          editor.add(tool)
        }
        for (const name of [...OPENCODE_V2_LOCAL_TOOLS, ...(harness.shell ? [] : ['shell'])]) {
          editor.remove(name)
        }
      })
      // opencode describes the tool named shell anew for each request, as the shell of this machine
      const shell = tools.find((tool) => tool.name === 'shell')
      if (!shell) {
        return
      }
      for (const name of ['context', 'compaction', 'generate'] as const) {
        await context.session.hook(name, (request) => {
          if (request.tools.shell) {
            request.tools.shell.description = shell.description
          }
        })
      }
    },
  }
}

/**
 * The plugin as the file `harness/opencode.ts` exports it, for opencode 2 and for opencode 1, which
 * takes the `server` of a plugin object: see {@link loadHammerkitOpencodePlugin}.
 */
export function hammerkitOpencodeEntry(
  load: (specifier: string) => Promise<any>,
  settings: OpencodePluginOptions = {}
): OpencodeV2Plugin & { server: OpencodePlugin } {
  return { ...hammerkitOpencodeV2Plugin(settings), server: loadHammerkitOpencodePlugin(load, settings) }
}

// what the tools of the plugin are made with besides the sandbox
export interface OpencodeToolOptions {
  // the tasks the description of run_task lists
  tasks?: TaskListing
  // the shell task, '' for none: then there is no shell tool on opencode 2, and bash refuses on opencode 1
  shell?: string
}

/**
 * The tools of opencode 2 on a hammerkit sandbox, with the inputs of opencode's own: the tools of
 * opencode 1 under their new names (`patch`, `shell`), paths as `path`, relative to `directory`
 * or absolute below it. opencode 2 has no `list`, `read` lists a directory.
 */
export function createOpencodeV2Tools(
  client: () => Promise<SandboxClient>,
  directory: string,
  options: OpencodeToolOptions = {}
): OpencodeV2Tool[] {
  const tools = opencodeTools(client, options)
  const shell = options.shell ?? DEFAULT_SHELL_TASK
  const tool = (
    name: string,
    of: string,
    input: { [key: string]: unknown },
    args: (input: any) => unknown,
    permission?: string
  ): OpencodeV2Tool => ({
    name,
    description: tools[of].description,
    input,
    options: permission ? { codemode: false, permission } : { codemode: false },
    async execute(input, context) {
      const done = await tools[of].execute(args(input), { directory, abort: context.signal })
      return { content: typeof done === 'string' ? done : done.output }
    },
  })
  const same = (input: unknown) => input
  const taskTools = Object.fromEntries(createTaskTools().map((task) => [task.name, task]))
  return [
    tool(
      'read',
      'read',
      object(
        {
          path: text('The file or directory to read, relative to the project or absolute'),
          offset: count('The line number to start reading from (1-based)'),
          limit: count(`The maximum number of lines to read (defaults to ${DEFAULT_READ_LINES})`),
        },
        ['path']
      ),
      ({ path, ...rest }) => ({ filePath: path, ...rest })
    ),
    tool(
      'write',
      'write',
      object({ path: text('The file to write'), content: text('The content to write to the file') }, [
        'path',
        'content',
      ]),
      ({ path, ...rest }) => ({ filePath: path, ...rest }),
      'edit'
    ),
    tool(
      'edit',
      'edit',
      object(
        {
          path: text('The file to modify'),
          oldString: text('The text to replace'),
          newString: text('The text to replace it with (must be different from oldString)'),
          replaceAll: flag('Replace all occurrences of oldString (default false)'),
        },
        ['path', 'oldString', 'newString']
      ),
      ({ path, ...rest }) => ({ filePath: path, ...rest }),
      'edit'
    ),
    tool(
      'patch',
      'apply_patch',
      object({ patchText: text('The full patch text that describes all changes to be made') }, ['patchText']),
      same,
      'edit'
    ),
    ...(shell
      ? [
          tool(
            'shell',
            'bash',
            object(
              {
                command: text('The command to execute'),
                workdir: text('The directory to run the command in, relative to the project. Use this instead of cd.'),
                timeout: count('Timeout in milliseconds, 0 for the default of the shell task'),
              },
              ['command']
            ),
            ({ timeout, ...rest }) => ({ ...rest, timeout: timeout || undefined })
          ),
        ]
      : []),
    tool(
      'glob',
      'glob',
      object(
        {
          pattern: text('The glob pattern to match files against, like "**/*.ts"'),
          path: text('The directory to search in, the project by default'),
          limit: count(`The maximum number of files (default ${SEARCH_LIMIT})`),
        },
        ['pattern']
      ),
      same
    ),
    tool(
      'grep',
      'grep',
      object(
        {
          pattern: text('The regular expression to search for in file contents'),
          path: text('The directory to search in, the project by default'),
          include: text('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
          literal: flag('Search for the pattern as plain text'),
          caseSensitive: flag('Match case (default true)'),
          limit: count(`The maximum number of matching lines (default ${SEARCH_LIMIT})`),
        },
        ['pattern']
      ),
      same
    ),
    ...['run_task', 'run_logs', 'check'].map((name) =>
      tool(name, name, { ...taskToolSchema(taskTools[name]), additionalProperties: false }, same)
    ),
    tool(
      'push',
      'push',
      object(
        {
          branch: text('The branch to push to, created when it does not exist'),
          message: text('The commit message'),
        },
        ['branch', 'message']
      ),
      same
    ),
    ...SERVICE_TOOLS.map((service) =>
      tool(service.name, service.name, { ...serviceToolSchema(service), additionalProperties: false }, same)
    ),
  ]
}

const text = (description: string) => ({ type: 'string', description })
const count = (description: string) => ({ type: 'integer', minimum: 0, description })
const flag = (description: string) => ({ type: 'boolean', description })
const object = (properties: { [name: string]: unknown }, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

export function createOpencodeTools(
  z: any,
  client: () => Promise<SandboxClient>,
  options: OpencodeToolOptions = {}
): { [name: string]: OpencodeTool } {
  return Object.fromEntries(
    Object.entries(opencodeTools(client, options)).map(([name, { args, ...tool }]) => [
      name,
      { ...tool, args: args(z) },
    ])
  )
}

// services_up, endpoint_get and services_stop, with their parameters for the zod of opencode 1
function opencodeServiceTools(client: () => Promise<SandboxClient>): { [name: string]: OpencodeToolBody } {
  return Object.fromEntries(
    SERVICE_TOOLS.map((tool) => [
      tool.name,
      {
        description: tool.description,
        args: (z: any) => serviceToolArgs(tool, z),
        async execute(args: unknown, context: OpencodeToolContext) {
          return { title: tool.title, output: await tool.call(await client(), args, context.abort) }
        },
      },
    ])
  )
}

// a tool of the plugin, with its parameters for the zod of opencode 1
interface OpencodeToolBody extends Omit<OpencodeTool, 'args'> {
  args(z: any): { [name: string]: unknown }
}

function opencodeTools(
  client: () => Promise<SandboxClient>,
  options: OpencodeToolOptions = {}
): { [name: string]: OpencodeToolBody } {
  const shell = options.shell ?? DEFAULT_SHELL_TASK
  const tasks = Object.fromEntries(
    createTaskTools(options.tasks, shell || undefined).map((task): [string, OpencodeToolBody] => [
      task.name,
      {
        description: task.description,
        args: (z) => taskToolArgs(task, z),
        async execute(args: { task?: string; run?: string }, context) {
          const output = await task.call(await client(), args, context.abort)
          return {
            title:
              task.name === 'run_logs'
                ? `log of ${args.run}`
                : `${task.name === 'check' ? 'check' : 'run'} ${args.task}`,
            output,
          }
        },
      },
    ])
  )
  // without a shell task bash still stands in for opencode's, which would run on this machine
  const noShell = 'There is no shell on this hammerkit sandbox: run the tasks of the build file with run_task.'
  const where = (context: OpencodeToolContext, path: string | undefined) =>
    toSandboxPath(context.directory, path ?? context.directory)

  return inOrder({
    read: {
      description:
        'Read a file or directory of the hammerkit sandbox. Lines come back numbered as `N: content`; ' +
        `offset is the first line (1-indexed), limit the number of lines (default ${DEFAULT_READ_LINES}).`,
      args: (z) => ({
        filePath: z.string().describe('The absolute path to the file or directory to read'),
        offset: z.number().int().min(0).optional().describe('The line number to start reading from (1-indexed)'),
        limit: z.number().int().min(0).optional().describe('The maximum number of lines to read (defaults to 2000)'),
      }),
      async execute(args: { filePath: string; offset?: number; limit?: number }, context) {
        const sandbox = await client()
        const path = where(context, args.filePath)
        const found = await sandbox.stat(path)
        if (!found) {
          throw new Error(`File not found: ${args.filePath}`)
        }
        if (found.type === 'directory') {
          const tree = await sandbox.tree({ path: path || undefined, depth: 1, limit: 1000 })
          const prefix = path ? `${path}/` : ''
          return [
            `<path>${args.filePath}</path>`,
            '<type>directory</type>',
            '<entries>',
            formatTree(tree, prefix),
            '</entries>',
          ].join('\n')
        }
        const read = await sandbox.read(path, args.offset || 1, args.limit || DEFAULT_READ_LINES)
        const last = read.nextOffset ? read.nextOffset - 1 : read.lines
        const footer = read.nextOffset
          ? `(Showing lines ${read.offset}-${last} of ${read.lines}. Use offset=${read.nextOffset} to continue.)`
          : `(End of file - total ${read.lines} lines)`
        return [
          `<path>${args.filePath}</path>`,
          '<type>file</type>',
          '<content>',
          toColonNumbers(read.content.replace(/\n$/, '')),
          '',
          footer,
          '</content>',
        ].join('\n')
      },
    },

    write: {
      description:
        'Write a file of the hammerkit sandbox, replacing it if it exists. Read a file before you overwrite it.',
      args: (z) => ({
        content: z.string().describe('The content to write to the file'),
        filePath: z.string().describe('The absolute path to the file to write (must be absolute, not relative)'),
      }),
      async execute(args: { content: string; filePath: string }, context) {
        const sandbox = await client()
        await sandbox.writeRaw(where(context, args.filePath), args.content)
        return 'Wrote file successfully.'
      },
    },

    edit: {
      description:
        'Replace an exact string in a file of the hammerkit sandbox. oldString has to match exactly once, ' +
        'unless replaceAll is set.',
      args: (z) => ({
        filePath: z.string().describe('The absolute path to the file to modify'),
        oldString: z.string().describe('The text to replace'),
        newString: z.string().describe('The text to replace it with (must be different from oldString)'),
        replaceAll: z.boolean().optional().describe('Replace all occurrences of oldString (default false)'),
      }),
      async execute(args: { filePath: string; oldString: string; newString: string; replaceAll?: boolean }, context) {
        if (args.oldString === args.newString) {
          throw new Error('No changes to apply: oldString and newString are identical.')
        }
        const sandbox = await client()
        const path = where(context, args.filePath)
        if (args.oldString === '') {
          // an empty oldString writes a new file, as opencode's edit does
          await sandbox.writeRaw(path, args.newString)
        } else {
          await sandbox.edit([
            {
              op: 'replace',
              path,
              old_string: args.oldString,
              new_string: args.newString,
              replace_all: args.replaceAll,
            },
          ])
        }
        return 'Edit applied successfully.'
      },
    },

    apply_patch: {
      description:
        'Apply a patch to the hammerkit sandbox: the `*** Begin Patch` format (Add File, Update File with ' +
        '@@ context, Delete File, Move to) or a unified git diff. All files change or none.',
      args: (z) => ({
        patchText: z.string().describe('The full patch text that describes all changes to be made'),
      }),
      async execute(args: { patchText: string }, context) {
        const sandbox = await client()
        const files = await sandbox.edit([{ op: 'patch', patch: patchToSandbox(context.directory, args.patchText) }])
        const marks = { added: 'A', modified: 'M', deleted: 'D' }
        return [
          'Success. Updated the following files:',
          ...files.map((file) => `${marks[file.change]} ${file.path}`),
        ].join('\n')
      },
    },

    bash: shell
      ? {
          description:
            'Run a shell command on the hammerkit sandbox, as the shell task of the published build file, in its ' +
            'container. Commands run one at a time and nothing is kept between them but the files. They start in ' +
            'the root of the sandbox, where the paths of this machine do not exist: give them relative paths.',
          args: (z) => ({
            command: z.string().describe('The command to execute'),
            timeout: z.number().int().min(1).optional().describe('Optional timeout in milliseconds'),
            workdir: z
              .string()
              .optional()
              .describe(
                "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands."
              ),
          }),
          async execute(args: { command: string; timeout?: number; workdir?: string }, context) {
            const sandbox = await client()
            const ran = await sandbox.exec(args.command, where(context, args.workdir), {
              signal: context.abort,
              timeoutSeconds: args.timeout ? args.timeout / 1000 : undefined,
            })
            const lines = [capOutput(ran.output, readLogHint(ran.run.id, shell))]
            if (ran.exitCode === null) {
              lines.push(`hammerkit: ${ran.result?.error ?? ran.run.error ?? `the run ended ${ran.run.state}`}`)
            } else if (ran.exitCode !== 0) {
              lines.push(`Exit code: ${ran.exitCode}`)
            }
            context.metadata?.({ metadata: { exit: ran.exitCode, run: ran.run.id } })
            return lines.filter((line) => line.length > 0).join('\n\n') || '(no output)'
          },
        }
      : {
          description: noShell,
          args: (z) => ({ command: z.string().describe('The command to execute') }),
          async execute() {
            throw new Error(noShell)
          },
        },

    grep: {
      description:
        'Search the files of the hammerkit sandbox with a regular expression (ripgrep). Returns the matching ' +
        'lines with their file and line number.',
      args: (z) => ({
        pattern: z.string().describe('The regex pattern to search for in file contents'),
        path: z.string().optional().describe('The directory to search in. Defaults to the current working directory.'),
        include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
      }),
      async execute(args: GrepArgs, context) {
        const sandbox = await client()
        const result = await sandbox.search({
          pattern: args.pattern,
          path: where(context, args.path) || undefined,
          glob: args.include ? [args.include] : undefined,
          fixed_strings: args.literal || undefined,
          i: args.caseSensitive === false || undefined,
          output_mode: 'content',
          head_limit: args.limit || SEARCH_LIMIT,
        })
        const matches = (result.matches ?? []).filter((match) => !match.context)
        if (matches.length === 0) {
          return 'No files found'
        }
        const lines = [`Found ${result.exact ? '' : 'at least '}${result.total} matches`]
        let file = ''
        for (const match of matches) {
          if (match.path !== file) {
            file = match.path
            lines.push('', `${join(context.directory, file)}:`)
          }
          lines.push(`  Line ${match.line}: ${match.text}`)
        }
        if (result.truncated) {
          lines.push('', '(Results are truncated. Consider using a more specific path or pattern.)')
        }
        return lines.join('\n')
      },
    },

    glob: {
      description: 'Find files of the hammerkit sandbox by a glob pattern like "**/*.js" or "src/**/*.ts".',
      args: (z) => ({
        pattern: z.string().describe('The glob pattern to match files against'),
        path: z
          .string()
          .optional()
          .describe('The directory to search in. If not specified, the current working directory will be used.'),
      }),
      async execute(args: { pattern: string; path?: string; limit?: number }, context) {
        const sandbox = await client()
        const tree = await sandbox.tree({
          path: where(context, args.path) || undefined,
          glob: args.pattern,
          limit: args.limit || SEARCH_LIMIT,
        })
        if (tree.entries.length === 0) {
          return 'No files found'
        }
        const lines = tree.entries.map((entry) => join(context.directory, ...entry.path.split('/')))
        if (tree.truncated) {
          lines.push('', '(Results are truncated. Consider using a more specific path or pattern.)')
        }
        return lines.join('\n')
      },
    },

    ...tasks,

    push: {
      description:
        'Commit the changes of the hammerkit sandbox and push them to a branch of its repository, for review. ' +
        'The server pushes only to the branches its operator allows; the sandbox is at the pushed commit afterwards.',
      args: (z) => ({
        branch: z.string().describe('The branch to push to, created when it does not exist'),
        message: z.string().describe('The commit message'),
      }),
      async execute(args: { branch: string; message: string }) {
        const pushed = await (await client()).push(args.branch, args.message)
        return { title: `pushed to ${pushed.branch}`, output: `pushed ${pushed.commit} to ${pushed.branch}` }
      },
    },

    // opencode's list: a tree of the first files below a directory
    list: {
      description:
        'List the files and directories below a directory of the hammerkit sandbox, as a tree. Prefer glob and ' +
        'grep when you know what you look for.',
      args: (z) => ({
        path: z
          .string()
          .optional()
          .describe('The absolute path to the directory to list (must be absolute, not relative)'),
        ignore: z.array(z.string()).optional().describe('List of glob patterns to ignore'),
      }),
      async execute(args: { path?: string; ignore?: string[] }, context) {
        const sandbox = await client()
        const path = where(context, args.path)
        const tree = await sandbox.tree({ path: path || undefined, depth: 64, limit: LIST_LIMIT })
        const prefix = path ? `${path}/` : ''
        const ignore = (args.ignore ?? []).map((pattern) => new Minimatch(pattern, { dot: true, matchBase: true }))
        const lines = [`${args.path ?? context.directory}/`]
        for (const entry of tree.entries) {
          const relative = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
          if (ignore.some((pattern) => pattern.match(relative))) {
            continue
          }
          const parts = relative.split('/')
          lines.push(`${'  '.repeat(parts.length)}${parts[parts.length - 1]}${entry.type === 'directory' ? '/' : ''}`)
        }
        if (tree.truncated) {
          lines.push('', `(${tree.entries.length} of ${tree.total} shown, list a directory below it or use glob)`)
        }
        return lines.join('\n')
      },
    },

    ...opencodeServiceTools(client),
  })
}

// opencode runs the tool calls of a step in parallel, they reach the sandbox one at a time in their order
function inOrder<T extends Pick<OpencodeTool, 'execute'>>(tools: { [name: string]: T }): { [name: string]: T } {
  const inTurn = oneAtATime()
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      { ...tool, execute: (args: any, context: OpencodeToolContext) => inTurn(() => tool.execute(args, context)) },
    ])
  )
}

// GPT models name the files of a patch by the absolute paths opencode shows them
export function patchToSandbox(root: string, patch: string): string {
  return patch.replace(
    /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.*?)([ \t\r]*)$/gm,
    (line, head: string, path: string, end: string) =>
      isAbsolute(path) ? `${head}${toSandboxPath(root, path)}${end}` : line
  )
}
