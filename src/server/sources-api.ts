import { IncomingMessage, ServerResponse } from 'http'
import { HASH_PATTERN } from '../remote/bundle'
import { MAX_MANIFEST_BODY_BYTES, sourceManifestSchema } from '../remote/source-manifest'
import { readJson, send } from './http'
import { Principal } from './oauth'
import { getGrant, mayRun } from './policy'
import { ServerConfig } from './server-config'
import { SourceError, SourceStore } from './sources'

/**
 * The project files of a caller, in two steps so that only what the server
 * lacks is sent:
 *
 *   POST   /v1/sources                  announce a tree (a manifest of paths and digests);
 *                                       answers its name and the digests still missing
 *   PUT    /v1/sources/blobs/<sha256>   send the content of one file
 *   GET    /v1/sources                  the caller's trees and what they take
 *   GET    /v1/sources/<hash>           one tree and what is still missing
 *   DELETE /v1/sources/<hash>           forget a tree and the content nothing else needs
 *
 * Everything is the caller's own: another caller's tree is `404`, and content is
 * never shared between callers.
 */
export async function handleSources(
  config: ServerConfig,
  store: SourceStore,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/sources(?:\/(blobs)\/([^/]+)|\/([^/]+))?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, blobs, digest, rawSnapshot] = match
  const method = req.method
  try {
    if (blobs) {
      if (method !== 'PUT') {
        send(res, 405, { error: 'method not allowed' }, { allow: 'PUT' })
        return true
      }
      mustMayUpload(config, principal)
      const result = await store.put(principal, digest, req)
      send(res, result === 'created' ? 201 : 200, { stored: digest })
      return true
    }
    if (rawSnapshot === undefined) {
      if (method === 'GET') {
        send(res, 200, await store.list(principal))
      } else if (method === 'POST') {
        mustMayUpload(config, principal)
        const parsed = sourceManifestSchema.safeParse(await readJson(req, MAX_MANIFEST_BODY_BYTES))
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
          return true
        }
        const { status, created } = await store.announce(principal, parsed.data)
        log(
          `source ${status.snapshot} iss=${principal.iss} sub=${principal.sub} files=${status.files} missing=${status.missing.length}`
        )
        send(res, created ? 201 : 200, { ...status, complete: status.missing.length === 0 })
      } else {
        send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })
      }
      return true
    }
    const snapshot = decodeSnapshot(rawSnapshot)
    if (method === 'GET') {
      const status = await store.get(principal, snapshot)
      status ? send(res, 200, { ...status, complete: status.missing.length === 0 }) : notFound(res)
    } else if (method === 'DELETE') {
      const removed = await store.remove(principal, snapshot)
      log(`source remove ${snapshot} iss=${principal.iss} sub=${principal.sub} found=${removed}`)
      removed ? send(res, 200, { removed: snapshot }) : notFound(res)
    } else {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET, DELETE' })
    }
    return true
  } catch (e) {
    if (e instanceof SourceError) {
      send(res, e.status, { error: e.message })
      return true
    }
    throw e
  }
}

// The colon of `sha256:<hex>` may arrive escaped.
function decodeSnapshot(raw: string): string {
  try {
    const value = decodeURIComponent(raw)
    return HASH_PATTERN.test(value) ? value : ''
  } catch {
    return ''
  }
}

function notFound(res: ServerResponse): void {
  send(res, 404, { error: 'not found' })
}

// Sending files is only for callers who may run something from an upload.
function mustMayUpload(config: ServerConfig, principal: Principal): void {
  const grant = getGrant(config.entitlements, principal)
  if (!mayRun(grant)) {
    throw new SourceError(403, 'uploads are not allowed for you')
  }
}
