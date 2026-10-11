import { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { bundleSchema, HASH_PATTERN, MAX_BUNDLE_BYTES } from '../remote/bundle'
import { DefinitionError, DefinitionStore } from './definitions'
import { readJson, send } from './http'
import { Principal, quote } from './oauth'
import { canUse, getGrant, mayPropose, mayPublish, maySeeDefinitions, mayYank } from './policy'
import { ProposalError, ProposalRegistry } from './proposals'
import { definitionName, ServerConfig } from './server-config'

// A bundle is JSON text with escapes, so the body may be somewhat larger than the files.
const MAX_PUBLISH_BYTES = MAX_BUNDLE_BYTES * 2

/**
 * The published build files:
 *
 *   PUT  /v1/definitions/<name>                 publish a bundle, or propose it when the
 *                                               caller may only propose (answers 202)
 *   GET  /v1/definitions                        the names, with their latest version
 *   GET  /v1/definitions/<name>                 the versions of one
 *   GET  /v1/definitions/<name>/<hash|latest>   one version
 *   GET  /v1/definitions/<name>/<hash|latest>/files   the files of one version
 *   POST /v1/definitions/<name>/<hash>/yank     pull a version back (body: optional {reason})
 *   POST /v1/definitions/<name>/<hash>/unyank   let it go on
 */
export async function handleDefinitions(
  config: ServerConfig,
  store: DefinitionStore,
  proposals: ProposalRegistry,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/definitions(?:\/([^/]+)(?:\/([^/]+)(\/files|\/yank|\/unyank)?)?)?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, name, version, suffix] = match
  const files = suffix === '/files'
  const grant = getGrant(config.entitlements, principal)

  if (name !== undefined && !definitionName.safeParse(name).success) {
    send(res, 404, { error: 'not found' })
    return true
  }

  if (name !== undefined && version === undefined && req.method === 'PUT') {
    await publish(config, store, proposals, log, principal, name, req, res)
    return true
  }
  if ((suffix === '/yank' || suffix === '/unyank') && req.method === 'POST') {
    await yank(config, store, log, principal, name as string, version, suffix === '/unyank', req, res)
    return true
  }
  if (req.method !== 'GET') {
    send(
      res,
      405,
      { error: 'method not allowed' },
      {
        allow:
          suffix === '/yank' || suffix === '/unyank' ? 'POST' : name !== undefined && !version ? 'GET, PUT' : 'GET',
      }
    )
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

const yankSchema = z.object({ reason: z.string().max(500).optional() }).strict()

// Yanking is allowed to who publishes the build file or uses an account the version
// uses; letting a version go on again is the publisher's call.
async function yank(
  config: ServerConfig,
  store: DefinitionStore,
  log: (line: string) => void,
  principal: Principal,
  name: string,
  hash: string,
  undo: boolean,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const grant = getGrant(config.entitlements, principal)
  const version = HASH_PATTERN.test(hash) ? store.find(name, hash) : undefined
  if (!version || !maySeeDefinitions(grant)) {
    send(res, 404, { error: 'not found' })
    return
  }
  if (undo ? !mayPublish(grant) : !mayYank(grant, version)) {
    log(`refuse ${undo ? 'unyank' : 'yank'} ${name}@${hash} iss=${principal.iss} sub=${principal.sub}`)
    send(res, 403, {
      error: undo
        ? 'a version is let go on by who publishes the build file'
        : 'a version is yanked by who publishes the build file or uses an account it uses',
    })
    return
  }
  const body = yankSchema.safeParse(req.headers['content-type'] ? await readJson(req) : {})
  if (!body.success) {
    const issue = body.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return
  }
  const changed = await store.yank(name, hash, principal, { reason: body.data.reason, undo })
  log(
    `${undo ? 'unyank' : 'yank'} ${name}@${hash} iss=${principal.iss} sub=${principal.sub}${
      body.data.reason ? ` reason=${quote(body.data.reason)}` : ''
    }`
  )
  send(res, 200, changed)
}

async function publish(
  config: ServerConfig,
  store: DefinitionStore,
  proposals: ProposalRegistry,
  log: (line: string) => void,
  principal: Principal,
  name: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const grant = getGrant(config.entitlements, principal)
  if (!mayPublish(grant) && !mayPropose(grant)) {
    log(`refuse publish iss=${principal.iss} sub=${principal.sub}: no builds permission`)
    send(res, 403, { error: `you may not publish ${name}, it needs builds: propose or publish` })
    return
  }
  const parsed = bundleSchema.safeParse(await readJson(req, MAX_PUBLISH_BYTES))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return
  }
  try {
    // a version can't run before it is approved, but it has to load, as it would
    // have when published, so the approver is not asked about a broken one
    const { version, existing } = await store.prepare(name, parsed.data, principal, {
      noRemote: !mayPublish(grant),
    })
    if (existing) {
      send(res, 200, { ...existing, created: false })
      return
    }
    // a version that names an account is published by somebody who uses it; anyone
    // else proposes it, and somebody who does approves it (four eyes)
    const missing = (version.accounts ?? []).filter((account) => !canUse(grant, account))
    if (!mayPublish(grant) || missing.length > 0) {
      const { proposal, created } = proposals.propose(
        version,
        parsed.data,
        principal,
        missing,
        store.find(name, 'latest')?.hash ?? null
      )
      log(
        `propose ${name} ${proposal.hash} iss=${principal.iss} sub=${principal.sub} created=${created} tasks=${
          proposal.tasks.length
        } missing=[${missing.join(',')}]`
      )
      send(res, created ? 202 : 200, { ...proposal, created })
      return
    }
    const { version: published, created } = await store.publish(name, parsed.data, principal)
    log(
      `publish ${name} ${published.hash} iss=${principal.iss} sub=${principal.sub} created=${created} tasks=${published.tasks.length}`
    )
    send(res, created ? 201 : 200, { ...published, created })
  } catch (e) {
    if (e instanceof DefinitionError) {
      log(`refuse publish iss=${principal.iss} sub=${principal.sub}: ${name} does not load`)
      send(res, 400, { error: `the build file does not load: ${e.message}` })
      return
    }
    if (e instanceof ProposalError) {
      send(res, e.status, { error: e.message })
      return
    }
    throw e
  }
}
