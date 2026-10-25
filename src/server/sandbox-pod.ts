import { randomBytes } from 'crypto'
import { rm } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { Readable, Writable } from 'stream'
import { GitOutputTooLarge } from './git-checkout'
import { EditOp, PatchAuthor, ReadQuery, SandboxFileError, SearchQuery, TreeQuery } from './sandbox-files'
import { HostSandboxStorage, SandboxKey } from './sandbox-storage'
import { packArchive } from '../utils/tar'

// On a cluster a sandbox is a claim, and what the server does with its files runs in a
// short pod that mounts it (see KubernetesSandboxStorage): `hammerkit server-sandbox
// <directory>` reads one request on its standard input, does it with the code of a host
// (HostSandboxStorage, with the claim as the directory of the sandbox), and answers on
// its standard output.

// The repository the server fetched a commit into, below the directory, which create and
// fetch take it from; it goes afterwards
export const INCOMING = 'incoming'
export const INCOMING_REF = 'hammerkit-fetched'

export type SandboxPodRequest =
  | { op: 'create'; id: string }
  | { op: 'fetch'; id: string }
  | { op: 'state'; id: string }
  | { op: 'usage'; id: string }
  | { op: 'stat'; id: string; path: string }
  | { op: 'tree'; id: string; query: TreeQuery }
  | { op: 'read'; id: string; path: string; query: ReadQuery }
  | { op: 'raw'; id: string; path: string }
  | { op: 'search'; id: string; query: SearchQuery }
  | { op: 'changes'; id: string }
  | { op: 'diff'; id: string; format: 'diff' | 'patch'; author: PatchAuthor }
  // plans the edits and writes them when `commit` is set
  | { op: 'edit'; id: string; ops: EditOp[]; commit: boolean }
  // the commit of the changes, for the server to push; the sandbox stays where it is
  | { op: 'commit'; id: string; author: PatchAuthor }
  // moves the sandbox to a commit it has, its files stay: what the server pushed
  | { op: 'move'; id: string; commit: string }
  // the files of a git tree that must be what the files are now, as a tar after the answer
  | { op: 'archive'; id: string; tree: string }

// The first line of the answer. A raw read sends the bytes of the file after it; `stream`
// says there are more than an answer holds in memory.
export type SandboxPodHeader =
  | { ok: true; result: unknown; stream?: boolean }
  | {
      ok: false
      error: { message: string; status?: number; details?: { [key: string]: unknown }; kind?: 'too-large' }
    }

// An edit crosses as JSON: bytes as base64.
export function encodeEditOps(ops: EditOp[]): EditOp[] {
  return ops.map((op) =>
    op.op === 'write' && Buffer.isBuffer(op.content)
      ? { ...op, content: op.content.toString('base64'), encoding: 'base64' }
      : op
  )
}

// The error of an answer, as the API would have thrown it on a host.
export function decodePodError(error: Extract<SandboxPodHeader, { ok: false }>['error']): Error {
  if (error.status) {
    return new SandboxFileError(error.status as SandboxFileError['status'], error.message, error.details ?? {})
  }
  if (error.kind === 'too-large') {
    return new GitOutputTooLarge(error.message)
  }
  return new Error(error.message)
}

function write(out: Writable, chunk: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => out.write(chunk, (e) => (e ? reject(e) : resolve())))
}

// A failure once the bytes of a raw read began: the answer can not say so any more, the
// command fails instead.
class AnswerStarted extends Error {}

async function answer(
  storage: HostSandboxStorage,
  directory: string,
  request: SandboxPodRequest,
  out: Writable
): Promise<void> {
  // the owner is the server's to check; in the pod there is only this sandbox
  const key: SandboxKey = { id: request.id, owner: { iss: '', sub: '' } }
  const files = () => storage.files(key)
  const send = (result: unknown) => write(out, JSON.stringify({ ok: true, result } satisfies SandboxPodHeader) + '\n')
  switch (request.op) {
    case 'create':
    case 'fetch': {
      const incoming = join(directory, INCOMING)
      try {
        const fetch = {
          url: pathToFileURL(incoming).href,
          ref: INCOMING_REF,
          env: {},
          signal: AbortSignal.timeout(10 * 60_000),
        }
        return await send(request.op === 'create' ? await storage.create(key, fetch) : await storage.fetch(key, fetch))
      } finally {
        await rm(incoming, { recursive: true, force: true })
      }
    }
    case 'state':
      return send(await storage.state(key))
    case 'usage':
      return send(await storage.usage(key))
    case 'stat':
      return send((await files().stat(request.path)) ?? null)
    case 'tree':
      return send(await files().tree(request.query))
    case 'read':
      return send(await files().read(request.path, request.query))
    case 'search':
      return send(await files().search(request.query))
    case 'changes':
      return send(await files().changes())
    case 'diff':
      return send(await files().diff(request.format, request.author))
    case 'commit':
      return send((await storage.commit(key, request.author, AbortSignal.timeout(10 * 60_000))) ?? null)
    case 'move':
      await storage.moveTo(key, request.commit)
      return send(null)
    case 'edit': {
      const plan = await files().plan(request.ops)
      if (request.commit) {
        await plan.commit()
      }
      return send({ files: plan.files, bytes: plan.bytes })
    }
    case 'archive': {
      // written beside the sandbox on the claim, sent, and removed
      const into = join(directory, `${request.id}-archive-${randomBytes(6).toString('hex')}`)
      try {
        await storage.exportTree(key, request.tree, into, AbortSignal.timeout(10 * 60_000))
        await write(out, JSON.stringify({ ok: true, result: null, stream: true } satisfies SandboxPodHeader) + '\n')
        try {
          for await (const chunk of packArchive({ cwd: into, portable: true }, ['.'])) {
            await write(out, chunk as Buffer)
          }
        } catch (e) {
          throw new AnswerStarted(e instanceof Error ? e.message : String(e))
        }
        return
      } finally {
        await rm(into, { recursive: true, force: true })
      }
    }
    case 'raw': {
      const raw = await files().raw(request.path)
      const header: SandboxPodHeader = {
        ok: true,
        result: { stat: raw.stat, sha256: raw.sha256 },
        ...(raw.stream ? { stream: true } : {}),
      }
      await write(out, JSON.stringify(header) + '\n')
      try {
        if (raw.content) {
          return await write(out, raw.content)
        }
        const stream = raw.stream as Readable
        for await (const chunk of stream) {
          await write(out, chunk as Buffer)
        }
      } catch (e) {
        throw new AnswerStarted(e instanceof Error ? e.message : String(e))
      }
      return
    }
  }
}

/**
 * Answers one request about the sandbox below `directory`. A failure of the request is an
 * answer too, with the status the API gives it; the process only fails when it can not
 * answer at all, or a raw read fails after its first bytes.
 */
export async function sandboxPodMain(directory: string, input: Readable, out: Writable): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of input) {
    chunks.push(chunk as Buffer)
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SandboxPodRequest
  const storage = new HostSandboxStorage(directory, process.env)
  try {
    await answer(storage, directory, request, out)
  } catch (e) {
    if (e instanceof AnswerStarted) {
      throw e
    }
    const error: Extract<SandboxPodHeader, { ok: false }>['error'] =
      e instanceof SandboxFileError
        ? { status: e.status, message: e.message, details: e.details }
        : e instanceof GitOutputTooLarge
          ? { kind: 'too-large', message: e.message }
          : { message: e instanceof Error ? e.message : String(e) }
    await write(out, JSON.stringify({ ok: false, error } satisfies SandboxPodHeader) + '\n')
  }
}
