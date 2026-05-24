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
import { join } from 'path'
import { CacheBackend } from '../cache-backend'

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
      } catch {
        return false
      }
    },
    async pull(taskId, stateKey, into, environment): Promise<boolean> {
      try {
        const head = await client
          .send(
            new HeadObjectCommand({
              Bucket: spec.bucket,
              Key: keyFor(taskId, stateKey, 'stats.json'),
            })
          )
          .catch(() => null)
        if (!head) {
          return false
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
      } catch {
        return false
      }
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
      let token: string | undefined
      do {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: spec.bucket,
            Prefix: taskPrefix(taskId),
            ContinuationToken: token,
          })
        )
        const objects = (listed.Contents ?? []).filter((o) => o.Key).map((o) => ({ Key: o.Key as string }))
        if (objects.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: spec.bucket,
              Delete: { Objects: objects },
            })
          )
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined
      } while (token)
    },
  }
}
