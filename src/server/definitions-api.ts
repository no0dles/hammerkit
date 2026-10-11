import { IncomingMessage, ServerResponse } from 'http'
import { bundleSchema, HASH_PATTERN, MAX_BUNDLE_BYTES } from '../remote/bundle'
import { DefinitionError, DefinitionStore } from './definitions'
import { readJson, send } from './http'
import { Principal } from './oauth'
import { getGrant, mayPublish, maySeeDefinitions } from './policy'
import { definitionName, ServerConfig } from './server-config'

// A bundle is JSON text with escapes, so the body may be somewhat larger than the files.
const MAX_PUBLISH_BYTES = MAX_BUNDLE_BYTES * 2

/**
 * The published build files:
 *
 *   PUT  /v1/definitions/<name>                 publish a bundle
 *   GET  /v1/definitions                        the names, with their latest version
 *   GET  /v1/definitions/<name>                 the versions of one
 *   GET  /v1/definitions/<name>/<hash|latest>   one version
 *   GET  /v1/definitions/<name>/<hash|latest>/files   the files of one version
 */
export async function handleDefinitions(
  config: ServerConfig,
  store: DefinitionStore,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/definitions(?:\/([^/]+)(?:\/([^/]+)(\/files)?)?)?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, name, version, files] = match
  const grant = getGrant(config.entitlements, principal)

  if (name !== undefined && !definitionName.safeParse(name).success) {
    send(res, 404, { error: 'not found' })
    return true
  }

  if (name !== undefined && version === undefined && req.method === 'PUT') {
    await publish(config, store, log, principal, name, req, res)
    return true
  }
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method not allowed' }, { allow: name !== undefined && !version ? 'GET, PUT' : 'GET' })
    return true
  }
  // what the caller may not see does not exist for them
  if (!maySeeDefinitions(grant)) {
    send(res, 404, { error: 'not found' })
    return true
  }

  if (name === undefined) {
    send(res, 200, {
      definitions: store.names().map((n) => ({ name: n, latest: store.find(n, 'latest')?.hash })),
    })
    return true
  }
  if (version === undefined) {
    const versions = store.list(name)
    versions.length > 0
      ? send(res, 200, { name, latest: versions[0].hash, versions })
      : send(res, 404, { error: 'not found' })
    return true
  }
  const found = version === 'latest' || HASH_PATTERN.test(version) ? store.find(name, version) : undefined
  if (!found) {
    send(res, 404, { error: 'not found' })
    return true
  }
  if (files) {
    const bundle = await store.files(found)
    bundle ? send(res, 200, bundle) : send(res, 404, { error: 'not found' })
  } else {
    send(res, 200, found)
  }
  return true
}

async function publish(
  config: ServerConfig,
  store: DefinitionStore,
  log: (line: string) => void,
  principal: Principal,
  name: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const grant = getGrant(config.entitlements, principal)
  if (!mayPublish(grant, name)) {
    log(`refuse publish iss=${principal.iss} sub=${principal.sub}: build file ${name} is not granted`)
    send(res, 403, { error: `you may not publish ${name}` })
    return
  }
  const parsed = bundleSchema.safeParse(await readJson(req, MAX_PUBLISH_BYTES))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return
  }
  try {
    const { version, created } = await store.publish(name, parsed.data, principal)
    log(
      `publish ${name} ${version.hash} iss=${principal.iss} sub=${principal.sub} created=${created} tasks=${version.tasks.length}`
    )
    send(res, created ? 201 : 200, { ...version, created })
  } catch (e) {
    if (e instanceof DefinitionError) {
      log(`refuse publish iss=${principal.iss} sub=${principal.sub}: ${name} does not load`)
      send(res, 400, { error: `the build file does not load: ${e.message}` })
      return
    }
    throw e
  }
}
