import { CHECK_DESCRIPTION, PublishedTask, runCheck, SandboxClient, TaskRun } from './sandbox-client'

// the most tasks a description lists, and of a task's description or command it shows
const MAX_LISTED = 40
const MAX_DESCRIPTION_CHARS = 200
const MAX_COMMAND_CHARS = 100
// how long a client waits for the tasks of the build file when it starts, it goes on without them
export const LIST_TASKS_MS = 15_000

/**
 * The tools of the harnesses that run the named tasks of the published build file: `run_task`,
 * `run_logs` and `check`. Each harness has the same two in its own shape, with the same parameters and
 * answers: only how a harness declares the parameters differs, which every schema of them says.
 */
export interface TaskTool {
  name: string
  title: string
  description: string
  parameters: { [name: string]: TaskToolParameter }
  required: string[]
  call(client: SandboxClient, args: any, signal?: AbortSignal): Promise<string>
}

export type TaskToolParameter =
  | { type: 'string' | 'string[]' | 'boolean'; description: string }
  | { type: 'integer'; description: string; minimum: number; maximum?: number }

/**
 * The tasks the description of `run_task` lists: those of the published version, or why they
 * could not be read, or nothing when the harness did not ask.
 */
export type TaskListing = PublishedTask[] | { error: string } | undefined

// The tasks of the published version, or why they could not be read within `ms`.
export async function readTaskListing(
  list: () => Promise<PublishedTask[]>,
  ms = LIST_TASKS_MS
): Promise<PublishedTask[] | { error: string }> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([list(), timeout])
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// the hint at the end of a cut output or a result, for the model
export function readLogHint(run: string, task: string): string {
  return `read more of the log with run_logs { "run": "${run}", "task": "${task}" }`
}

// A run of a task in a few lines: how it went, why it ran, its last lines.
export function describeRun(task: string, ran: TaskRun): string {
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
  lines.push(readLogHint(ran.run.id, task))
  return lines.join('\n')
}

/**
 * The tasks for the model, one line each: what it is for (or its command, when the build
 * file says nothing) and whether it takes arguments. `shell` is left out, the shell tool runs it.
 */
export function describeTasks(listing: TaskListing, shell?: string): string {
  if (listing === undefined) {
    return ''
  }
  if (!Array.isArray(listing)) {
    return `The tasks of the build file could not be listed (${listing.error}); name one as the build file does.`
  }
  const tasks = listing.filter((task) => !shell || task.name !== shell)
  if (tasks.length === 0) {
    return 'The published build file has no tasks to run.'
  }
  const lines = tasks.slice(0, MAX_LISTED).map((task) => {
    const parts = [`- ${task.name}`]
    if (task.description) {
      parts.push(`: ${cut(oneLine(task.description), MAX_DESCRIPTION_CHARS)}`)
    } else if (task.command) {
      parts.push(`: runs \`${cut(oneLine(task.command), MAX_COMMAND_CHARS)}\``)
    }
    if (task.args === null) {
      parts.push(' (takes args)')
    } else if (task.args !== undefined || task.command === null) {
      parts.push(' (takes no args)')
    }
    return parts.join('')
  })
  if (tasks.length > MAX_LISTED) {
    lines.push(`- and ${tasks.length - MAX_LISTED} more`)
  }
  return ['The tasks of the published build file:', ...lines].join('\n')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * `run_task`, `run_logs` and `check`, with the tasks the description of `run_task` lists. Without a
 * listing it names none, as the MCP tools before a version could be read.
 */
export function createTaskTools(listing?: TaskListing, shell?: string): TaskTool[] {
  const tasks = describeTasks(listing, shell)
  return [
    {
      name: 'run_task',
      title: 'Run a task',
      description:
        'Run a task of the published build file on the sandbox, such as test or build, and answer how it went: ' +
        'its status, exit code, why it was not taken from the cache, and its last lines. args are appended to ' +
        'its last command, for example a test file. It runs in the container, with the network and the ' +
        'options the build file gives the task.' +
        (tasks ? `\n\n${tasks}` : ''),
      parameters: {
        task: { type: 'string', description: 'The name of the task' },
        args: { type: 'string[]', description: 'Arguments for its last command' },
      },
      required: ['task'],
      async call(client, args, signal) {
        const ran = await client.runTask(args.task, { args: args.args?.length ? args.args : undefined, signal })
        return describeRun(args.task, ran)
      },
    },
    {
      name: 'run_logs',
      title: 'Read the log of a run',
      description:
        'Read the log of a run as numbered lines: one task, the last lines (tail), a range (from, limit) or ' +
        'the lines that contain a text (grep, a fixed string) with lines of context around them.',
      parameters: {
        run: { type: 'string', description: 'The id of the run' },
        task: { type: 'string', description: 'Only the lines of this task' },
        tail: {
          type: 'integer',
          description: 'The last lines, or with grep the last matches',
          minimum: 1,
          maximum: 1000,
        },
        from: { type: 'integer', description: 'The first line to read', minimum: 1 },
        limit: { type: 'integer', description: 'How many lines to read', minimum: 1, maximum: 1000 },
        grep: { type: 'string', description: 'Only lines that contain this text' },
        ignore_case: { type: 'boolean', description: 'Ignore case in grep' },
        context: { type: 'integer', description: 'Lines before and after each match', minimum: 0, maximum: 20 },
      },
      required: ['run'],
      async call(client, args) {
        const page = await client.logs(args.run, {
          task: args.task || undefined,
          tail: args.tail || undefined,
          from: args.from || undefined,
          limit: args.limit || undefined,
          grep: args.grep || undefined,
          i: args.ignore_case || undefined,
          context: args.context || undefined,
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
      name: 'check',
      title: 'Run a check',
      description: CHECK_DESCRIPTION,
      parameters: { task: { type: 'string', description: 'The name of the task' } },
      required: ['task'],
      call(client, args, signal) {
        return runCheck(client, args.task, signal)
      },
    },
  ]
}

// The parameters as a JSON schema, for MCP and opencode 2.
export function taskToolSchema(tool: TaskTool): {
  type: 'object'
  properties: { [name: string]: unknown }
  required: string[]
} {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(tool.parameters).map(([name, parameter]) => {
        if (parameter.type === 'string[]') {
          return [name, { type: 'array', items: { type: 'string' }, description: parameter.description }]
        }
        if (parameter.type === 'integer') {
          const { maximum } = parameter
          return [
            name,
            {
              type: 'integer',
              description: parameter.description,
              minimum: parameter.minimum,
              ...(maximum !== undefined ? { maximum } : {}),
            },
          ]
        }
        return [name, { type: parameter.type, description: parameter.description }]
      })
    ),
    required: tool.required,
  }
}

// The parameters with the zod of opencode 1.
export function taskToolArgs(tool: TaskTool, z: any): { [name: string]: unknown } {
  return Object.fromEntries(
    Object.entries(tool.parameters).map(([name, parameter]) => {
      let type
      if (parameter.type === 'string[]') {
        type = z.array(z.string())
      } else if (parameter.type === 'integer') {
        type = z.number().int().min(parameter.minimum)
        type = parameter.maximum !== undefined ? type.max(parameter.maximum) : type
      } else {
        type = parameter.type === 'boolean' ? z.boolean() : z.string()
      }
      return [name, (tool.required.includes(name) ? type : type.optional()).describe(parameter.description)]
    })
  )
}
