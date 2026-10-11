import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { Readable } from 'stream'
import { Principal } from './oauth'
import { HASH_PATTERN } from '../remote/bundle'
import { deniedSourcePath, DIGEST_PATTERN, hashSource, SourceManifest } from '../remote/source-manifest'

export class SourceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413,
    message: string
  ) {
    super(message)
  }
}

export interface SourceLimits {
  // what one caller may keep on the server, all manifests together
  subjectBytes: number
}

export const DEFAULT_SOURCE_LIMITS: SourceLimits = { subjectBytes: 4 * 1024 * 1024 * 1024 }

export interface SourceStatus {
  snapshot: string
  files: number
  bytes: number
  createdAt: string
  // digests of content the server does not have yet
  missing: string[]
}

interface StoredManifest {
  manifest: SourceManifest
  createdAt: string
}

// Everything of one caller: the manifests they sent and the content behind them.
interface Subject {
  // digest -> size, for every file of every manifest: only these may be uploaded
  wanted: Map<string, number>
  // bytes of content kept
  stored: number
  manifests: Map<string, StoredManifest>
}

// The directory name of a caller: the issuer and subject, hashed.
export function subjectKey(principal: Pick<Principal, 'iss' | 'sub'>): string {
  return createHash('sha256')
    .update(JSON.stringify([principal.iss, principal.sub]))
    .digest('hex')
    .slice(0, 32)
}

/**
 * The project files that runs on this server work on, kept per caller:
 *
 *   <directory>/<caller>/blobs/<sha-256>            content, once per digest
 *   <directory>/<caller>/manifests/<hash>.json      the trees that were announced
 *
 * Content is shared between the manifests of one caller and never between
 * callers: a server that answers "I have this file" to anybody would tell them
 * what other people work on.
 */
export class SourceStore {
  private readonly subjects = new Map<string, Promise<Subject>>()

  constructor(
    private readonly directory: string,
    private readonly limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
    private readonly now: () => number = Date.now
  ) {}

  // Announces a tree. Answers what has to be sent to complete it.
  async announce(principal: Principal, manifest: SourceManifest): Promise<{ status: SourceStatus; created: boolean }> {
    const denied = manifest.files
      .map((file) => ({ path: file.path, reason: deniedSourcePath(file.path) }))
      .filter((entry) => entry.reason !== null)
    if (denied.length > 0) {
      const shown = denied
        .slice(0, 5)
        .map((entry) => `${entry.path} (${entry.reason})`)
        .join(', ')
      throw new SourceError(
        400,
        `${denied.length} file${denied.length === 1 ? '' : 's'} may not be sent: ${shown}${
          denied.length > 5 ? ', ...' : ''
        }`
      )
    }
    const key = subjectKey(principal)
    const subject = await this.subject(key)
    const snapshot = hashSource(manifest)
    const existing = subject.manifests.get(snapshot)
    if (existing) {
      return { status: await this.statusOf(key, snapshot, existing), created: false }
    }
    // one digest has one size
    const sizes = new Map<string, number>()
    for (const file of manifest.files) {
      const known = sizes.get(file.sha256) ?? subject.wanted.get(file.sha256)
      if (known !== undefined && known !== file.size) {
        throw new SourceError(400, `${file.path}: ${file.sha256} is announced with two sizes`)
      }
      sizes.set(file.sha256, file.size)
    }
    const stored: StoredManifest = { manifest, createdAt: new Date(this.now()).toISOString() }
    await mkdir(join(this.directory, key, 'manifests'), { recursive: true })
    await this.write(join(this.directory, key, 'manifests', `${snapshot.slice('sha256:'.length)}.json`), stored)
    subject.manifests.set(snapshot, stored)
    for (const [digest, size] of sizes) {
      subject.wanted.set(digest, size)
    }
    return { status: await this.statusOf(key, snapshot, stored), created: true }
  }

  // Keeps the content of one file, once the digest of what arrives is the one
  // that was announced. Only content of an announced tree is taken.
  async put(principal: Principal, digest: string, body: Readable): Promise<'created' | 'exists'> {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new SourceError(404, 'not found')
    }
    const key = subjectKey(principal)
    const subject = await this.subject(key)
    const size = subject.wanted.get(digest)
    if (size === undefined) {
      throw new SourceError(400, 'this file is not part of a tree you announced')
    }
    const target = this.blob(key, digest)
    if (await exists(target)) {
      body.resume()
      return 'exists'
    }
    if (subject.stored + size > this.limits.subjectBytes) {
      body.resume()
      throw new SourceError(413, `the server keeps at most ${this.limits.subjectBytes} bytes of files for you`)
    }
    await mkdir(join(this.directory, key, 'blobs'), { recursive: true })
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`
    const hash = createHash('sha256')
    let received = 0
    const out = createWriteStream(temporary, { flags: 'wx' })
    try {
      for await (const chunk of body) {
        received += chunk.length
        if (received > size) {
          throw new SourceError(400, `the file is larger than the ${size} bytes that were announced`)
        }
        hash.update(chunk)
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.once('error', reject)
        out.end(resolve)
      })
      if (received !== size) {
        throw new SourceError(400, `the file has ${received} bytes, ${size} were announced`)
      }
      if (hash.digest('hex') !== digest) {
        throw new SourceError(400, 'the content does not have the digest it was sent for')
      }
      await rename(temporary, target)
    } catch (e) {
      out.destroy()
      await rm(temporary, { force: true })
      throw e
    }
    subject.stored += size
    return 'created'
  }

  async get(principal: Principal, snapshot: string): Promise<SourceStatus | undefined> {
    if (!HASH_PATTERN.test(snapshot)) {
      return undefined
    }
    const key = subjectKey(principal)
    const subject = await this.subject(key)
    const stored = subject.manifests.get(snapshot)
    return stored ? this.statusOf(key, snapshot, stored) : undefined
  }

  async list(
    principal: Principal
  ): Promise<{ snapshots: Omit<SourceStatus, 'missing'>[]; bytes: number; limit: number }> {
    const subject = await this.subject(subjectKey(principal))
    const snapshots = [...subject.manifests.entries()]
      .map(([snapshot, stored]) => ({
        snapshot,
        files: stored.manifest.files.length,
        bytes: stored.manifest.files.reduce((sum, file) => sum + file.size, 0),
        createdAt: stored.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { snapshots, bytes: subject.stored, limit: this.limits.subjectBytes }
  }

  // Forgets a tree and the content nothing else of the caller's needs.
  async remove(principal: Principal, snapshot: string): Promise<boolean> {
    if (!HASH_PATTERN.test(snapshot)) {
      return false
    }
    const key = subjectKey(principal)
    const subject = await this.subject(key)
    if (!subject.manifests.delete(snapshot)) {
      return false
    }
    await rm(join(this.directory, key, 'manifests', `${snapshot.slice('sha256:'.length)}.json`), { force: true })
    const kept = new Map<string, number>()
    for (const stored of subject.manifests.values()) {
      for (const file of stored.manifest.files) {
        kept.set(file.sha256, file.size)
      }
    }
    for (const [digest, size] of subject.wanted) {
      if (!kept.has(digest)) {
        subject.wanted.delete(digest)
        if (await exists(this.blob(key, digest))) {
          await rm(this.blob(key, digest), { force: true })
          subject.stored -= size
        }
      }
    }
    return true
  }

  private async statusOf(key: string, snapshot: string, stored: StoredManifest): Promise<SourceStatus> {
    const missing: string[] = []
    for (const digest of new Set(stored.manifest.files.map((file) => file.sha256))) {
      if (!(await exists(this.blob(key, digest)))) {
        missing.push(digest)
      }
    }
    return {
      snapshot,
      files: stored.manifest.files.length,
      bytes: stored.manifest.files.reduce((sum, file) => sum + file.size, 0),
      createdAt: stored.createdAt,
      missing,
    }
  }

  private blob(key: string, digest: string): string {
    return join(this.directory, key, 'blobs', digest)
  }

  private async write(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' })
    await rename(temporary, file)
  }

  // Reads what is kept for one caller the first time they are seen.
  private subject(key: string): Promise<Subject> {
    let loaded = this.subjects.get(key)
    if (!loaded) {
      loaded = this.load(key)
      this.subjects.set(key, loaded)
    }
    return loaded
  }

  private async load(key: string): Promise<Subject> {
    const subject: Subject = { wanted: new Map(), stored: 0, manifests: new Map() }
    const manifests = join(this.directory, key, 'manifests')
    let names: string[] = []
    try {
      names = await readdir(manifests)
    } catch {
      return subject
    }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const stored: StoredManifest = JSON.parse(await readFile(join(manifests, name), 'utf8'))
      subject.manifests.set(hashSource(stored.manifest), stored)
      for (const file of stored.manifest.files) {
        subject.wanted.set(file.sha256, file.size)
      }
    }
    for (const [digest, size] of subject.wanted) {
      try {
        await stat(this.blob(key, digest))
        subject.stored += size
      } catch {
        // announced, not sent yet
      }
    }
    return subject
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}
