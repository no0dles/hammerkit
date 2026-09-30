import { createHash, randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { create, extract } from 'tar'
import { CacheBackend } from '../cache-backend'
import { Environment } from '../../executer/environment'
import { parseRegistryReference } from './registry/registry-reference'
import {
  digestBuffer,
  digestFile,
  ImageManifest,
  OCI_CONFIG,
  OCI_LAYER_TAR,
  OCI_MANIFEST,
  RegistryClient,
} from './registry/registry-client'

export interface RegistryCacheBackendSpec {
  type: 'registry'
  repository: string
  insecure?: boolean
}

const MAX_TAG_LENGTH = 128

// The deterministic tag for one entry. A task id (sha1) plus a state key (md5)
// fits comfortably; anything longer is hashed rather than rejected.
export function entryTag(taskId: string, stateKey: string): string {
  const tag = `${taskId}-${stateKey}`
  if (tag.length <= MAX_TAG_LENGTH && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tag)) {
    return tag
  }
  return `${taskId.substring(0, 40)}-${createHash('sha256').update(stateKey).digest('hex').substring(0, 64)}`
}

async function withTempDir<T>(environment: Environment, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `hammerkit-registry-${randomUUID()}`)
  await environment.file.createDirectory(dir)
  try {
    return await fn(dir)
  } finally {
    await environment.file.remove(dir)
  }
}

// Stores each cache entry as a standard single-layer OCI image (ADR-0005): the
// layer is an uncompressed tar of the entry directory (whose archives are
// already gzipped), tagged `<taskId>-<stateKey>`. The manifest is written only
// after both blobs are committed, so a partial upload is never visible to
// has()/pull(); a re-push of the same content is an identical overwrite.
export function createRegistryCacheBackend(spec: RegistryCacheBackendSpec): CacheBackend {
  const reference = parseRegistryReference(spec.repository, spec.insecure)
  const clients = new WeakMap<Environment, RegistryClient>()
  const client = (environment: Environment) => {
    let instance = clients.get(environment)
    if (!instance) {
      instance = new RegistryClient(reference, environment)
      clients.set(environment, instance)
    }
    return instance
  }

  return {
    type: 'registry',
    async has(taskId, stateKey, environment): Promise<boolean> {
      return client(environment).manifestExists(entryTag(taskId, stateKey))
    },
    async pull(taskId, stateKey, into, environment): Promise<boolean> {
      const registry = client(environment)
      const manifest = await registry.getManifest(entryTag(taskId, stateKey))
      if (!manifest) {
        return false
      }
      if (manifest.layers.length !== 1) {
        throw new Error(`cache entry ${entryTag(taskId, stateKey)} is not a single-layer image`)
      }
      return withTempDir(environment, async (dir) => {
        const layerFile = join(dir, 'layer.tar')
        await registry.downloadBlob(manifest.layers[0], layerFile)
        await environment.file.createDirectory(into)
        // node-tar strips absolute paths and `..` segments by default, so a
        // crafted layer cannot write outside `into`
        await extract({ file: layerFile, cwd: into })
        return true
      })
    },
    async push(taskId, stateKey, from, environment): Promise<void> {
      const registry = client(environment)
      await withTempDir(environment, async (dir) => {
        const layerFile = join(dir, 'layer.tar')
        const files = (await environment.file.listFiles(from)).sort()
        // portable + mtime-free so identical entries produce identical digests
        // `noMtime` is supported by tar 6 but missing from its type definitions
        await create({ file: layerFile, cwd: from, portable: true, noMtime: true } as any, files)
        const layer = await digestFile(layerFile)

        const config = Buffer.from(
          JSON.stringify({
            architecture: 'amd64',
            os: 'linux',
            rootfs: { type: 'layers', diff_ids: [layer.digest] },
            config: { Labels: { 'dev.hammerkit.task-id': taskId, 'dev.hammerkit.state-key': stateKey } },
          })
        )
        const configDigest = digestBuffer(config)

        await registry.uploadBlob(layer.digest, layer.size, { file: layerFile })
        await registry.uploadBlob(configDigest.digest, configDigest.size, { buffer: config })

        const manifest: ImageManifest = {
          schemaVersion: 2,
          mediaType: OCI_MANIFEST,
          config: { mediaType: OCI_CONFIG, ...configDigest },
          layers: [{ mediaType: OCI_LAYER_TAR, ...layer }],
        }
        await registry.putManifest(entryTag(taskId, stateKey), manifest)
      })
    },
    async clear(taskId, environment): Promise<void> {
      const registry = client(environment)
      const tags = (await registry.listTags()).filter((tag) => tag.startsWith(`${taskId}-`))
      for (const tag of tags) {
        const digest = await registry.manifestDigest(tag)
        if (digest) {
          await registry.deleteManifest(digest)
        }
      }
    },
  }
}
