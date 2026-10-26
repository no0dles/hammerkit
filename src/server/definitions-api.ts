import { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { annotationsSchema, bundleSchema, HASH_PATTERN, MAX_BUNDLE_BYTES } from '../remote/bundle'
import { DefinitionError, DefinitionStore, DefinitionVersion } from './definitions'
import { readJson, send } from './http'
import { describeArguments } from './run-plan'
import { Principal, quote } from './oauth'
import { canUse, getGrant, mayPropose, mayPublish, maySeeDefinitions, mayYank } from './policy'
import { ProposalError, ProposalRegistry } from './proposals'
import { ServerConfig } from './server-config'

// A bundle is JSON text with escapes, so the body may be somewhat larger than the files.
const MAX_PUBLISH_BYTES = MAX_BUNDLE_BYTES * 2

/**
 * The published build files, each version named by its hash:
 *
 *   POST /v1/definitions                 publish a bundle, or propose it when the caller
 *                                        may only propose (answers 202); answers its hash.
 *                                        Beside entry and files the body may carry
 *                                        `annotations`, which are not part of the hash
 *   GET  /v1/definitions                 the versions, newest first; `?<key>=<value>`
 *                                        keeps the ones with those annotations
 *   GET  /v1/definitions/<hash>          one version, with `arguments`: per task null when
 *                                        a run of it may pass arguments, else why not
 *   GET  /v1/definitions/<hash>/files    its files
 *   POST /v1/definitions/plan            what publishing a bundle would do: plans it with this
 *                                        server's policy and stores nothing. For anybody with
 *                                        a `builds` level, `run` too
 *   POST /v1/definitions/<hash>/yank     pull it back (body: optional {reason})
 *   POST /v1/definitions/<hash>/unyank   let it go on
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
  if (url.pathname === '/v1/definitions/plan') {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    } else {
      await plan(config, store, log, principal, req, res)
    }
    return true
  }
  const match = /^\/v1\/definitions(?:\/([^/]+)(\/files|\/yank|\/unyank)?)?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, hash, suffix] = match
  const grant = getGrant(config.entitlements, principal)

  if (hash !== undefined && !HASH_PATTERN.test(hash)) {
    send(res, 404, { error: 'not found' })
    return true
  }

  if (hash === undefined && req.method === 'POST') {
    await publish(config, store, proposals, log, principal, req, res)
    return true
  }
  if ((suffix === '/yank' || suffix === '/unyank') && req.method === 'POST') {
    await yank(config, store, log, principal, hash, suffix === '/unyank', req, res)
    return true
  }
  if (req.method !== 'GET') {
    send(
      res,
      405,
      { error: 'method not allowed' },
      { allow: suffix === '/yank' || suffix === '/unyank' ? 'POST' : hash === undefined ? 'GET, POST' : 'GET' }
    )
    return true
  }
  // what the caller may not see does not exist for them
  if (!maySeeDefinitions(grant)) {
    send(res, 404, { error: 'not found' })
    return true
  }

  if (hash === undefined) {
    const wanted = [...url.searchParams.entries()]
    send(res, 200, {
      definitions: store
        .list()
        .filter((version) => wanted.every(([key, value]) => version.annotations?.[key] === value))
        .map(toSummary),
    })
    return true
  }
  const found = store.find(hash)
  if (!found) {
    send(res, 404, { error: 'not found' })
    return true
  }
  if (suffix === '/files') {
    const bundle = await store.files(found)
    bundle ? send(res, 200, bundle) : send(res, 404, { error: 'not found' })
  } else {
    send(res, 200, found.plan ? { ...found, arguments: describeArguments(found.plan, config.runs) } : found)
  }
  return true
}

// What the list shows of a version: who published it and when, and what it runs as.
function toSummary(version: DefinitionVersion) {
  const { hash, entry, publishedAt, publishedBy, approvedBy, annotations, tasks, services, accounts, yanked } = version
  return {
    hash,
    entry,
    publishedAt,
    publishedBy,
    approvedBy,
    annotations: annotations ?? {},
    tasks,
    services,
    accounts: accounts ?? [],
    yanked,
  }
}

const yankSchema = z.object({ reason: z.string().max(500).optional() }).strict()

// Yanking is allowed to who publishes the build file or uses an account the version
// uses; letting a version go on again is the publisher's call.
async function yank(
  config: ServerConfig,
  store: DefinitionStore,
  log: (line: string) => void,
  principal: Principal,
  hash: string,
  undo: boolean,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const grant = getGrant(config.entitlements, principal)
  const version = store.find(hash)
  if (!version || !maySeeDefinitions(grant)) {
    send(res, 404, { error: 'not found' })
    return
  }
  if (undo ? !mayPublish(grant) : !mayYank(grant, version)) {
    log(`refuse ${undo ? 'unyank' : 'yank'} ${hash} iss=${principal.iss} sub=${principal.sub}`)
    send(res, 403, {
      error: undo
        ? 'a version is let go on by who publishes build files'
        : 'a version is yanked by who publishes build files or uses an account it uses',
    })
    return
  }
  const body = yankSchema.safeParse(req.headers['content-type'] ? await readJson(req) : {})
  if (!body.success) {
    const issue = body.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return
  }
  const changed = await store.yank(hash, principal, { reason: body.data.reason, undo })
  log(
    `${undo ? 'unyank' : 'yank'} ${hash} iss=${principal.iss} sub=${principal.sub}${
      body.data.reason ? ` reason=${quote(body.data.reason)}` : ''
    }`
  )
  send(res, 200, changed)
}

// Answers what POST /v1/definitions would: the version with its plan, and whether the
// caller would publish or propose it. A developer checks a build file against the policy
// before the account that publishes does. Nothing is stored, nothing is logged but the call.
async function plan(
  config: ServerConfig,
  store: DefinitionStore,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const grant = getGrant(config.entitlements, principal)
  if (grant.builds === null) {
    send(res, 403, { error: 'you may not check build files, it needs builds: run, propose or publish' })
    return
  }
  const parsed = bundleSchema.safeParse(await readJson(req, MAX_PUBLISH_BYTES))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return
  }
  try {
    // like a proposal: a caller who may not publish does not make the server fetch
    const { version, existing } = await store.prepare(parsed.data, principal, { noRemote: !mayPublish(grant) })
    const missing = (version.accounts ?? []).filter((account) => !canUse(grant, account))
    const outcome = existing
      ? 'already published'
      : mayPublish(grant) && missing.length === 0
        ? 'published'
        : mayPublish(grant) || mayPropose(grant)
          ? 'proposed'
          : null
    log(`plan ${version.hash} iss=${principal.iss} sub=${principal.sub} tasks=${version.tasks.length}`)
    send(res, 200, {
      hash: version.hash,
      tasks: version.tasks,
      services: version.services,
      plan: version.plan,
      accounts: version.accounts,
      outcome,
      ...(missing.length > 0 ? { missing } : {}),
    })
  } catch (e) {
    if (e instanceof DefinitionError) {
      send(res, 400, { error: `the build file does not load: ${e.message}` })
      return
    }
    throw e
  }
}

async function publish(
  config: ServerConfig,
  store: DefinitionStore,
  proposals: ProposalRegistry,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const grant = getGrant(config.entitlements, principal)
  if (!mayPublish(grant) && !mayPropose(grant)) {
    log(`refuse publish iss=${principal.iss} sub=${principal.sub}: no builds permission`)
    send(res, 403, { error: 'you may not publish build files, it needs builds: propose or publish' })
    return
  }
  const body = await readJson(req, MAX_PUBLISH_BYTES)
  // the annotations ride along with the bundle, they are not part of it
  const { annotations: said, ...rest } = body && typeof body === 'object' ? body : ({} as any)
  const annotated = annotationsSchema.optional().safeParse(said)
  if (!annotated.success) {
    const issue = annotated.error.issues[0]
    send(res, 400, { error: `${['annotations', ...issue.path].join('.')}: ${issue.message}` })
    return
  }
  const annotations = annotated.data
  const parsed = bundleSchema.safeParse(rest)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return
  }
  try {
    // a version can't run before it is approved, but it has to load, as it would
    // have when published, so the approver is not asked about a broken one
    const { version, existing } = await store.prepare(parsed.data, principal, {
      noRemote: !mayPublish(grant),
      annotations,
    })
    if (existing) {
      send(res, 200, { ...existing, created: false })
      return
    }
    // a version that names an account is published by somebody who uses it; anyone
    // else proposes it, and somebody who does approves it (four eyes)
    const missing = (version.accounts ?? []).filter((account) => !canUse(grant, account))
    if (!mayPublish(grant) || missing.length > 0) {
      const { proposal, created } = proposals.propose(version, parsed.data, principal, missing)
      log(
        `propose ${proposal.hash} iss=${principal.iss} sub=${principal.sub} created=${created} tasks=${
          proposal.tasks.length
        } missing=[${missing.join(',')}]`
      )
      send(res, created ? 202 : 200, { ...proposal, created })
      return
    }
    const { version: published, created } = await store.publish(parsed.data, principal, { annotations })
    log(
      `publish ${published.hash} iss=${principal.iss} sub=${principal.sub} created=${created} tasks=${published.tasks.length}`
    )
    send(res, created ? 201 : 200, { ...published, created })
  } catch (e) {
    if (e instanceof DefinitionError) {
      log(`refuse publish iss=${principal.iss} sub=${principal.sub}: the build file does not load`)
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
