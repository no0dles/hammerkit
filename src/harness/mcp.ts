import { createInterface } from 'readline'
import { Readable, Writable } from 'stream'
import { capOutput, formatSearch, formatTree } from './format'
import { SandboxClient } from './sandbox-client'
import type { TaskRun } from './sandbox-client'

// the newest first; a client asking for an older one gets it
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface McpAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpTool {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: { [name: string]: unknown }; required?: string[] }
  annotations: McpAnnotations
  call(args: any, signal: AbortSignal): Promise<string>
}

const READ_ONLY: McpAnnotations = { readOnlyHint: true, openWorldHint: false }
const EDITS: McpAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}

const text = (description: string) => ({ type: 'string', description })
const count = (description: string, minimum = 0, maximum?: number) => ({
  type: 'integer',
  description,
  minimum,
  ...(maximum !== undefined ? { maximum } : {}),
})
const flag = (description: string) => ({ type: 'boolean', description })

// MCP clients send paths as they like them: `/src/a.ts` is `src/a.ts` of the sandbox
function sandboxPath(path: string | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function readLog(run: string, task: string): string {
  return `read more of the log with run_logs { "run": "${run}", "task": "${task}" }`
}

function describeRun(task: string, ran: TaskRun): string {
  const result = ran.result
  const lines = [`run ${ran.run.id}: ${ran.run.state}`]
  if (result) {
    lines.push(
      `task ${task}: ${result.status}` +
        (result.exitCode !== undefined ? `, exit code ${result.exitCode}` : '') +
        (result.durationMs !== undefined ? `, ${result.durationMs} ms` : '') +
        (result.cache?.hit ? ', from the cache' : '')
    )
    if (result.error) {
      lines.push(`error: ${result.error}`)
    }
    if (result.cache?.causes?.length) {
      lines.push(`ran because: ${result.cache.causes.join('; ')}`)
    }
  } else if (ran.run.error) {
    lines.push(`error: ${ran.run.error}`)
  }
  if (result && result.lastLog.length > 0) {
    lines.push('last lines:', ...result.lastLog)
  }
  lines.push(readLog(ran.run.id, task))
  return lines.join('\n')
}

/**
 * The tools of `hammerkit remote mcp`, for chat clients and agents without file and shell tools of
 * their own. They take the shapes models are trained on: numbered reads with offset and
 * limit, exact-string replace, `apply_patch` or a git diff, ripgrep's parameters, a shell
 * command. Paths are relative to the root of the sandbox.
 */
export function createMcpTools(client: () => Promise<SandboxClient>): McpTool[] {
  return [
    {
      name: 'read',
      description:
        'Read a file of the sandbox. Lines come back numbered like `cat -n`: the number, a tab, the line. ' +
        'Long files come in parts; offset is the first line (1-based), limit the number of lines.',
      inputSchema: {
        type: 'object',
        properties: {
          path: text('Path of the file, relative to the root of the sandbox'),
          offset: count('The first line to read, 1 for the start', 1),
          limit: count('How many lines to read', 1),
        },
        required: ['path'],
      },
      annotations: { title: 'Read a file', ...READ_ONLY },
      async call(args) {
        const read = await (await client()).read(sandboxPath(args.path), args.offset, args.limit)
        const footer = read.nextOffset
          ? `(lines ${read.offset} to ${read.nextOffset - 1} of ${read.lines}, read on with offset ${read.nextOffset})`
          : `(end of file, ${read.lines} lines)`
        return `${read.content.replace(/\n$/, '')}\n\n${footer}`
      },
    },
    {
      name: 'write',
      description: 'Write a file of the sandbox, replacing what it held. Directories are made as needed.',
      inputSchema: {
        type: 'object',
        properties: { path: text('Path of the file'), content: text('The whole new content of the file') },
        required: ['path', 'content'],
      },
      annotations: { title: 'Write a file', ...EDITS, idempotentHint: true },
      async call(args) {
        const written = await (await client()).writeRaw(sandboxPath(args.path), args.content)
        return `${written.change} ${written.path} (${written.size ?? Buffer.byteLength(args.content)} bytes)`
      },
    },
    {
      name: 'edit',
      description:
        'Replace an exact string in a file of the sandbox. old_string has to match exactly once, with its ' +
        'whitespace and indentation, unless replace_all is set; give enough lines around the change to make it unique.',
      inputSchema: {
        type: 'object',
        properties: {
          path: text('Path of the file'),
          old_string: text('The text to replace, exactly as it is in the file'),
          new_string: text('The text to put in its place'),
          replace_all: flag('Replace every occurrence of old_string'),
        },
        required: ['path', 'old_string', 'new_string'],
      },
      annotations: { title: 'Edit a file', ...EDITS },
      async call(args) {
        const files = await (
          await client()
        ).edit([
          {
            op: 'replace',
            path: sandboxPath(args.path),
            old_string: args.old_string,
            new_string: args.new_string,
            replace_all: args.replace_all,
          },
        ])
        return files.map((file) => `${file.change} ${file.path}`).join('\n') || 'nothing changed'
      },
    },
    {
      name: 'apply_patch',
      description:
        'Change several files at once with a patch: the `*** Begin Patch` format (`*** Add File:`, ' +
        '`*** Update File:` with `@@` context lines, `*** Delete File:`, `*** Move to:`) or a unified git diff. ' +
        'Every file changes, or none does.',
      inputSchema: {
        type: 'object',
        properties: { patch: text('The patch, from `*** Begin Patch` to `*** End Patch`, or a git diff') },
        required: ['patch'],
      },
      annotations: { title: 'Apply a patch', ...EDITS },
      async call(args) {
        const files = await (await client()).edit([{ op: 'patch', patch: args.patch }])
        return files.map((file) => `${file.change} ${file.path}`).join('\n') || 'nothing changed'
      },
    },
    {
      name: 'search',
      description:
        'Search the files of the sandbox with ripgrep. pattern is a regular expression (Rust syntax); output_mode ' +
        'is files_with_matches (the default), content (matching lines, with -A/-B/-C context) or count.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: text('The regular expression to look for'),
          path: text('A file or directory to search in, the whole sandbox by default'),
          glob: text('Only files matching this glob, like "*.ts" or "src/**/*.tsx"'),
          type: text('Only files of this ripgrep type, like ts, py or rust'),
          '-i': flag('Ignore case'),
          fixed_strings: flag('Take the pattern as a literal string'),
          multiline: flag('Let the pattern match across lines'),
          '-A': count('Lines after each match (content mode)', 0, 100),
          '-B': count('Lines before each match (content mode)', 0, 100),
          '-C': count('Lines before and after each match (content mode)', 0, 100),
          output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
          head_limit: count('The most results to answer', 1, 5000),
        },
        required: ['pattern'],
      },
      annotations: { title: 'Search files', ...READ_ONLY },
      async call(args) {
        const query = { ...args, path: args.path ? sandboxPath(args.path) || undefined : undefined }
        return formatSearch(await (await client()).search(query))
      },
    },
    {
      name: 'glob',
      description: 'List the files of the sandbox that match a glob, like "**/*.ts" or "src/**/package.json".',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: text('The glob, relative to path'),
          path: text('The directory to look in, the root by default'),
        },
        required: ['pattern'],
      },
      annotations: { title: 'Find files', ...READ_ONLY },
      async call(args) {
        const path = sandboxPath(args.path) || undefined
        return formatTree(await (await client()).tree({ path, glob: args.pattern, limit: 500 }))
      },
    },
    {
      name: 'bash',
      description:
        'Run a shell command on the sandbox and answer its output and exit code. It runs as the shell task of ' +
        'the published build file, in its container and with its network; commands run one at a time, and ' +
        'only the files are kept between them.',
      inputSchema: {
        type: 'object',
        properties: {
          command: text('The command'),
          workdir: text('The directory to run it in, relative to the root of the sandbox'),
          timeout: count('Stop the command after this many seconds', 1),
        },
        required: ['command'],
      },
      annotations: { title: 'Run a command' },
      async call(args, signal) {
        const sandbox = await client()
        const ran = await sandbox.exec(args.command, sandboxPath(args.workdir), {
          signal,
          timeoutSeconds: args.timeout,
        })
        const output = capOutput(ran.output, readLog(ran.run.id, sandbox.build.shell))
        const lines = output ? [output, ''] : []
        if (ran.exitCode === null) {
          lines.push(`hammerkit: ${ran.result?.error ?? ran.run.error ?? `the run ended ${ran.run.state}`}`)
        } else {
          lines.push(`exit code ${ran.exitCode}`)
        }
        return lines.join('\n')
      },
    },
    {
      name: 'run_task',
      description:
        'Run a task of the published build file on the sandbox, such as test or build, and answer how it went: ' +
        'its status, exit code, why it was not taken from the cache, and its last lines. args are appended to ' +
        'its last command, for example a test file.',
      inputSchema: {
        type: 'object',
        properties: {
          task: text('The name of the task'),
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments for its last command' },
        },
        required: ['task'],
      },
      annotations: { title: 'Run a task' },
      async call(args, signal) {
        const ran = await (await client()).runTask(args.task, { args: args.args, signal })
        return describeRun(args.task, ran)
      },
    },
    {
      name: 'run_logs',
      description:
        'Read the log of a run as numbered lines: one task, the last lines (tail), a range (from, limit) or ' +
        'the lines that contain a text (grep, a fixed string) with lines of context around them.',
      inputSchema: {
        type: 'object',
        properties: {
          run: text('The id of the run'),
          task: text('Only the lines of this task'),
          tail: count('The last lines, or with grep the last matches', 1, 1000),
          from: count('The first line to read', 1),
          limit: count('How many lines to read', 1, 1000),
          grep: text('Only lines that contain this text'),
          ignore_case: flag('Ignore case in grep'),
          context: count('Lines before and after each match', 0, 20),
        },
        required: ['run'],
      },
      annotations: { title: 'Read the log of a run', ...READ_ONLY },
      async call(args) {
        const page = await (
          await client()
        ).logs(args.run, {
          task: args.task,
          tail: args.tail,
          from: args.from,
          limit: args.limit,
          grep: args.grep,
          i: args.ignore_case,
          context: args.context,
        })
        const lines = page.lines.map(
          (line) => `${line.line}${line.match === false ? '-' : ':'} ${args.task ? '' : `[${line.task}] `}${line.text}`
        )
        lines.push(
          '',
          `(${page.total} lines${
            args.grep ? ` searched, ${page.lines.filter((line) => line.match !== false).length} match here` : ''
          }${page.next ? `, read on with from ${page.next}` : ''}${
            page.truncated ? ', the server cut the log off at its limit' : ''
          })`
        )
        return lines.join('\n')
      },
    },
    {
      name: 'changes',
      description:
        'What changed in the sandbox since the commit it was fetched at: a summary of the files, a diff, or a ' +
        'patch to apply elsewhere with git am.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['summary', 'diff', 'patch'], description: 'summary by default' },
        },
      },
      annotations: { title: 'Show the changes', ...READ_ONLY },
      async call(args) {
        const sandbox = await client()
        if (args.format === 'diff' || args.format === 'patch') {
          return (await sandbox.diff(args.format)) || 'no changes'
        }
        const changes = await sandbox.changes()
        if (changes.files.length === 0) {
          return `no changes since ${changes.commit}`
        }
        return [
          `changes since ${changes.commit}:`,
          ...changes.files.map(
            (file) =>
              `${file.status} ${file.from ? `${file.from} -> ` : ''}${file.path}` +
              (file.additions !== null ? ` +${file.additions} -${file.deletions}` : ' (binary)')
          ),
        ].join('\n')
      },
    },
  ]
}

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: any
}

/**
 * A Model Context Protocol server over stdio: one JSON-RPC message per line on `input`, the
 * answers on `output`. It answers `initialize`, `ping`, `tools/list` and `tools/call`, and
 * stops a call when the client cancels it. Resolves when the input ends.
 */
export async function serveMcp(
  input: Readable,
  output: Writable,
  tools: McpTool[],
  server: { name: string; version: string; instructions?: string }
): Promise<void> {
  const running = new Map<string | number, AbortController>()
  const pending = new Set<Promise<void>>()
  const send = (message: object) => {
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const reply = (id: string | number, result: object) => send({ id, result })
  const fail = (id: string | number | null, code: number, message: string) => send({ id, error: { code, message } })

  const handle = async (message: JsonRpcMessage) => {
    const id = message.id
    if (message.method === 'notifications/cancelled') {
      running.get(message.params?.requestId)?.abort()
      return
    }
    if (id === undefined || id === null || message.method === undefined) {
      // a notification, or an answer of the client to a request this server never sends
      return
    }
    if (message.method === 'initialize') {
      const asked = message.params?.protocolVersion
      reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      })
    } else if (message.method === 'ping') {
      reply(id, {})
    } else if (message.method === 'tools/list') {
      reply(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
      })
    } else if (message.method === 'tools/call') {
      const tool = tools.find((candidate) => candidate.name === message.params?.name)
      if (!tool) {
        return fail(id, -32602, `unknown tool ${String(message.params?.name)}`)
      }
      const args = message.params?.arguments ?? {}
      const missing = (tool.inputSchema.required ?? []).filter((name) => args[name] === undefined)
      if (missing.length > 0) {
        return reply(id, { content: [{ type: 'text', text: `missing ${missing.join(', ')}` }], isError: true })
      }
      const abort = new AbortController()
      running.set(id, abort)
      try {
        const text = await tool.call(args, abort.signal)
        if (!abort.signal.aborted) {
          reply(id, { content: [{ type: 'text', text }] })
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          // a failed call is an answer the model reads, not a protocol error
          reply(id, { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
        }
      } finally {
        running.delete(id)
      }
    } else {
      fail(id, -32601, `method not found: ${String(message.method)}`)
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue
    }
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line)
    } catch {
      fail(null, -32700, 'parse error')
      continue
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      fail(null, -32600, 'invalid request')
      continue
    }
    const work = handle(message).catch((e) =>
      message.id !== undefined && message.id !== null
        ? fail(message.id, -32603, e instanceof Error ? e.message : String(e))
        : undefined
    )
    pending.add(work)
    work.finally(() => pending.delete(work))
  }
  for (const abort of running.values()) {
    abort.abort()
  }
  await Promise.all(pending)
}
