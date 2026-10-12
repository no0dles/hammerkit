import { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { GitOutputTooLarge } from './git-checkout'
import { HttpError, readJson, send } from './http'
import { Principal } from './oauth'
import { EditOp, FileStat, MAX_FILE_BYTES, SandboxFileError, SearchQuery } from './sandbox-files'
import { Sandbox, SandboxError, SandboxRegistry } from './sandboxes'

// a batch of edits carries the content it writes
export const MAX_EDITS_BODY_BYTES = 16 * 1024 * 1024

export type SandboxFileAction = 'tree' | 'search' | 'edits' | 'changes' | 'files'

const hashSchema = z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected the sha256 of the file, 64 hex digits')

const opSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('replace'),
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
      ifHash: hashSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('write'),
      path: z.string(),
      content: z.string(),
      encoding: z.enum(['utf8', 'base64']).optional(),
      ifHash: hashSchema.optional(),
    })
    .strict(),
  z.object({ op: z.literal('delete'), path: z.string(), ifHash: hashSchema.optional() }).strict(),
  z.object({ op: z.literal('move'), path: z.string(), to: z.string(), ifHash: hashSchema.optional() }).strict(),
  z.object({ op: z.literal('patch'), patch: z.string().min(1) }).strict(),
])

const editsSchema = z.object({ dryRun: z.boolean().optional(), ops: z.array(opSchema).min(1).max(1000) }).strict()

// grep tools name the flags `-i`, `-A`: both spellings are taken
const searchSchema = z.preprocess(
  (body) => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return body
    }
    const renamed: { [key: string]: unknown } = {}
    for (const [key, value] of Object.entries(body)) {
      renamed[/^-[iABC]$/.test(key) ? key.slice(1) : key] = value
    }
    return renamed
  },
  z
    .object({
      pattern: z.string().min(1).max(10_000),
      path: z.string().optional(),
      glob: z
        .union([z.string().min(1).max(500), z.array(z.string().min(1).max(500)).max(20)])
        .transform((glob) => (Array.isArray(glob) ? glob : [glob]))
        .optional(),
      type: z.string().optional(),
      i: z.boolean().optional(),
      fixed_strings: z.boolean().optional(),
      multiline: z.boolean().optional(),
      A: z.number().int().min(0).max(100).optional(),
      B: z.number().int().min(0).max(100).optional(),
      C: z.number().int().min(0).max(100).optional(),
      output_mode: z.enum(['files_with_matches', 'content', 'count']).optional(),
      head_limit: z.number().int().min(1).max(5000).optional(),
      cursor: z.string().optional(),
    })
    .strict()
)

/**
 * The files of a sandbox, for clients without tools of their own (typed) and for harnesses
 * that only swap the backend of theirs (raw):
 *
 *   GET  /v1/sandboxes/<id>/tree?path=&depth=&glob=&limit=&cursor=
 *   GET  /v1/sandboxes/<id>/files/<path>?offset=&limit=   numbered lines
 *   GET  /v1/sandboxes/<id>/files/<path>?raw              bytes
 *   GET  /v1/sandboxes/<id>/files/<path>?stat             what it is
 *   HEAD /v1/sandboxes/<id>/files/<path>                  the same, as headers
 *   PUT  /v1/sandboxes/<id>/files/<path>                  write bytes, If-Match: "<sha256>"
 *   POST /v1/sandboxes/<id>/search                        ripgrep
 *   POST /v1/sandboxes/<id>/edits                         { dryRun, ops }, all or nothing
 *   GET  /v1/sandboxes/<id>/changes?format=summary|diff|patch
 *
 * Reading a file works at any time. Writes, and the reads that walk the files (tree, search,
 * changes), are `409` while a run holds the sandbox.
 */
export async function handleSandboxFiles(
  sandboxes: SandboxRegistry,
  log: (line: string) => void,
  principal: Principal,
  sandbox: Sandbox,
  action: SandboxFileAction,
  path: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const who = `iss=${principal.iss} sub=${principal.sub}`
  const method = req.method
  try {
    if (action === 'files') {
      await handleFile(sandboxes, log, principal, sandbox, path as string, req, res, url)
    } else if (action === 'tree') {
      if (method !== 'GET') {
        return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      }
      const query = {
        path: url.searchParams.get('path') || undefined,
        depth: intParam(url, 'depth'),
        glob: url.searchParams.get('glob') || undefined,
        limit: intParam(url, 'limit'),
        cursor: url.searchParams.get('cursor') ?? undefined,
      }
      const tree = await sandboxes.read(principal, sandbox.id, (files) => files.tree(query))
      send(res, 200, tree)
    } else if (action === 'search') {
      if (method !== 'POST') {
        return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      }
      const query = parse(searchSchema, await readJson(req)) as SearchQuery
      send(res, 200, await sandboxes.read(principal, sandbox.id, (files) => files.search(query)))
    } else if (action === 'edits') {
      if (method !== 'POST') {
        return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      }
      const body = parse(editsSchema, await readJson(req, MAX_EDITS_BODY_BYTES))
      const files = await sandboxes.edit(principal, sandbox.id, body.ops as EditOp[], body.dryRun)
      if (!body.dryRun) {
        log(`sandbox edits ${sandbox.id} ${who} ops=${body.ops.length} files=${files.length}`)
      }
      send(res, 200, { dryRun: body.dryRun ?? false, files })
    } else {
      if (method !== 'GET') {
        return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      }
      await handleChanges(sandboxes, principal, sandbox, res, url)
    }
  } catch (e) {
    if (e instanceof SandboxFileError) {
      return send(res, e.status, { error: e.message, ...e.details })
    }
    if (e instanceof GitOutputTooLarge) {
      return send(res, 413, { error: 'the changes are too large to answer, take them out in parts with a push' })
    }
    throw e
  }
}

async function handleFile(
  sandboxes: SandboxRegistry,
  log: (line: string) => void,
  principal: Principal,
  sandbox: Sandbox,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const method = req.method
  const files = sandboxes.files(principal, sandbox.id)
  if (method === 'HEAD') {
    const stat = await files.stat(path)
    if (!stat) {
      res.writeHead(404, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, statHeaders(stat))
    res.end()
  } else if (method === 'GET') {
    if (url.searchParams.has('stat')) {
      const stat = await files.stat(path)
      return stat ? send(res, 200, stat) : send(res, 404, { error: `${path} does not exist` })
    }
    if (url.searchParams.has('raw')) {
      const raw = await files.raw(path)
      const headers = { ...statHeaders(raw.stat), 'content-type': 'application/octet-stream' }
      if (raw.content) {
        res.writeHead(200, { ...headers, etag: `"${raw.sha256}"` })
        res.end(raw.content)
        return
      }
      res.writeHead(200, headers)
      const stream = raw.stream as NonNullable<typeof raw.stream>
      await new Promise<void>((resolve) => {
        stream.on('error', () => {
          res.destroy()
          resolve()
        })
        res.on('close', () => {
          stream.destroy()
          resolve()
        })
        stream.pipe(res)
      })
      return
    }
    send(res, 200, await files.read(path, { offset: intParam(url, 'offset'), limit: intParam(url, 'limit') }))
  } else if (method === 'PUT') {
    const content = await readBytes(req, MAX_FILE_BYTES)
    const ifMatch = /^(?:W\/)?"?([0-9a-fA-F]{64})"?$/.exec(req.headers['if-match'] ?? '')
    if (req.headers['if-match'] !== undefined && !ifMatch) {
      return send(res, 400, { error: 'If-Match: expected the sha256 of the file in quotes' })
    }
    const [written] = await sandboxes.edit(principal, sandbox.id, [
      { op: 'write', path, content, ifHash: ifMatch?.[1] },
    ])
    log(`sandbox write ${sandbox.id} iss=${principal.iss} sub=${principal.sub} bytes=${content.length}`)
    // writing what the file already holds changes nothing
    send(res, written?.change === 'added' ? 201 : 200, written ?? { path, change: 'unchanged', size: content.length })
  } else {
    send(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD, PUT' })
  }
}

async function handleChanges(
  sandboxes: SandboxRegistry,
  principal: Principal,
  sandbox: Sandbox,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const format = url.searchParams.get('format') ?? 'summary'
  if (format === 'summary') {
    const files = await sandboxes.read(principal, sandbox.id, (files) => files.changes())
    return send(res, 200, { commit: sandbox.commit, files })
  }
  if (format !== 'diff' && format !== 'patch') {
    return send(res, 400, { error: 'format: expected summary, diff or patch' })
  }
  const author = {
    name: textParam(url, 'name') ?? 'hammerkit',
    email: textParam(url, 'email') ?? 'hammerkit@localhost',
    message: textParam(url, 'message', 4000, true) ?? `Changes of sandbox ${sandbox.id}`,
  }
  const text = await sandboxes.read(principal, sandbox.id, (files) => files.diff(format, author))
  res.writeHead(200, { 'content-type': 'text/x-diff; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function statHeaders(stat: FileStat): { [key: string]: string } {
  return {
    'cache-control': 'no-store',
    'content-length': String(stat.size),
    'last-modified': new Date(stat.modifiedAt).toUTCString(),
    'x-hammerkit-type': stat.type,
    'x-hammerkit-exec': String(stat.exec),
    ...(stat.target !== undefined ? { 'x-hammerkit-target': encodeURIComponent(stat.target) } : {}),
  }
}

function intParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name)
  if (value === null || value === '') {
    return undefined
  }
  if (!/^\d{1,9}$/.test(value)) {
    throw new SandboxFileError(400, `${name}: expected a whole number`)
  }
  return Number(value)
}

function textParam(url: URL, name: string, max = 200, lines = false): string | undefined {
  const value = url.searchParams.get(name)
  if (value === null || value === '') {
    return undefined
  }
  if (value.length > max || (lines ? /\0/ : /[\0\r\n<>]/).test(value)) {
    throw new SandboxFileError(400, `${name}: at most ${max} characters${lines ? '' : ', no line breaks or <>'}`)
  }
  return value
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw new HttpError(413, `the file is larger than ${limit} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new SandboxError(400, `${issue.path.join('.') || 'request'}: ${issue.message}`)
  }
  return parsed.data
}
