import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Readable } from 'stream'
import { readFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { CacheBackend, CacheEntry } from '../cache-backend'

// S3 object keys are arbitrary strings (unlike filesystem listings), so a
// poisoned/shared bucket can return a key whose suffix contains `../` and escape
// the restore directory once joined. Resolve the target and confirm it stays
// within `into`; anything outside is dropped rather than written.
function isWithin(into: string, filename: string): boolean {
  const base = resolve(into)
  const target = resolve(base, filename)
  return target === base || target.startsWith(base + sep)
}

// Only a missing object is a cache miss. Anything else (unreachable endpoint,
// denied credentials) is rethrown: the inline cache lookup catches it and
// degrades to a miss with a warning, while an explicit `cache pull`/`push`
// reports it and fails.
function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
  return err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404
}

export interface S3CacheBackendSpec {
  type: 's3'
  bucket: string
  region?: string
  endpoint?: string
  prefix?: string
  forcePathStyle?: boolean
}

export function createS3CacheBackend(spec: S3CacheBackendSpec): CacheBackend {
  const client = new S3Client({
    region: spec.region,
    endpoint: spec.endpoint,
    forcePathStyle: spec.forcePathStyle ?? !!spec.endpoint,
  })
  const prefix = (spec.prefix ?? '').replace(/^\/+|\/+$/g, '')

  function keyFor(taskId: string, stateKey: string, filename: string): string {
    return [prefix, taskId, stateKey, filename].filter((p) => p.length > 0).join('/')
  }

  function dirPrefix(taskId: string, stateKey: string): string {
    return [prefix, taskId, stateKey].filter((p) => p.length > 0).join('/') + '/'
  }

  function taskPrefix(taskId: string): string {
    return [prefix, taskId].filter((p) => p.length > 0).join('/') + '/'
  }

  async function listObjects(listPrefix: string): Promise<{ Key: string; Size: number; LastModified?: Date }[]> {
    const objects: { Key: string; Size: number; LastModified?: Date }[] = []
    let token: string | undefined
    do {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: spec.bucket, Prefix: listPrefix, ContinuationToken: token })
      )
      for (const obj of listed.Contents ?? []) {
        if (obj.Key) {
          objects.push({ Key: obj.Key, Size: obj.Size ?? 0, LastModified: obj.LastModified })
        }
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined
    } while (token)
    return objects
  }

  async function deleteObjects(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: spec.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
        })
      )
    }
  }

  return {
    type: 's3',
    async has(taskId, stateKey): Promise<boolean> {
      try {
        await client.send(
          new HeadObjectCommand({
            Bucket: spec.bucket,
            Key: keyFor(taskId, stateKey, 'stats.json'),
          })
        )
        return true
      } catch (e) {
        if (isNotFound(e)) {
          return false
        }
        throw e
      }
    },
    async pull(taskId, stateKey, into, environment): Promise<boolean> {
      try {
        await client.send(
          new HeadObjectCommand({
            Bucket: spec.bucket,
            Key: keyFor(taskId, stateKey, 'stats.json'),
          })
        )
      } catch (e) {
        if (isNotFound(e)) {
          return false
        }
        throw e
      }
      await environment.file.createDirectory(into)
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: spec.bucket,
          Prefix: dirPrefix(taskId, stateKey),
        })
      )
      for (const obj of listed.Contents ?? []) {
        if (!obj.Key) continue
        const filename = obj.Key.substring(dirPrefix(taskId, stateKey).length)
        if (!filename) continue
        if (!isWithin(into, filename)) {
          environment.console.warn(`skipping cache object outside restore dir: ${obj.Key}`)
          continue
        }
        const body = await client.send(
          new GetObjectCommand({
            Bucket: spec.bucket,
            Key: obj.Key,
          })
        )
        if (body.Body instanceof Readable) {
          await environment.file.writeStream(join(into, filename), body.Body)
        }
      }
      return true
    },
    async push(taskId, stateKey, from, environment) {
      const files = await environment.file.listFiles(from)
      const ordered = [
        ...files.filter((f) => f !== 'stats.json' && f !== 'description.json'),
        ...files.filter((f) => f === 'description.json'),
        ...files.filter((f) => f === 'stats.json'),
      ]
      for (const file of ordered) {
        const body = await readFile(join(from, file))
        await client.send(
          new PutObjectCommand({
            Bucket: spec.bucket,
            Key: keyFor(taskId, stateKey, file),
            Body: body,
          })
        )
      }
    },
    async clear(taskId): Promise<void> {
      await deleteObjects((await listObjects(taskPrefix(taskId))).map((o) => o.Key))
    },
    // Entries from object metadata: size is the sum of the entry's objects,
    // created is when stats.json (written last) landed. S3 keeps no last-use
    // marker, so retention on S3 works from age and size.
    async list(): Promise<CacheEntry[]> {
      const root = prefix.length > 0 ? `${prefix}/` : ''
      const entries = new Map<string, CacheEntry & { complete: boolean }>()
      for (const obj of await listObjects(root)) {
        const [taskId, stateKey, ...rest] = obj.Key.substring(root.length).split('/')
        if (!taskId || !stateKey || rest.length === 0) {
          continue
        }
        const id = `${taskId}/${stateKey}`
        const entry = entries.get(id) ?? {
          taskId,
          stateKey,
          size: 0,
          createdAt: null,
          lastAccessedAt: null,
          complete: false,
        }
        entry.size = (entry.size ?? 0) + obj.Size
        if (rest.join('/') === 'stats.json') {
          entry.complete = true
          entry.createdAt = obj.LastModified?.getTime() ?? null
        }
        entries.set(id, entry)
      }
      return [...entries.values()].filter((entry) => entry.complete).map(({ complete, ...entry }) => entry) // eslint-disable-line @typescript-eslint/no-unused-vars
    },
    async remove(taskId, stateKey): Promise<void> {
      // stats.json first, so a concurrent reader sees the entry as missing
      // rather than half-deleted
      const objects = (await listObjects(dirPrefix(taskId, stateKey))).map((o) => o.Key)
      const stats = objects.filter((key) => key.endsWith('/stats.json'))
      await deleteObjects(stats)
      await deleteObjects(objects.filter((key) => !stats.includes(key)))
    },
  }
}
