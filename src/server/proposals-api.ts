import { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { HASH_PATTERN } from '../remote/bundle'
import { DefinitionError, DefinitionStore } from './definitions'
import { readJson, send } from './http'
import { Principal, quote } from './oauth'
import { canUse, getGrant, Grant, mayPublish } from './policy'
import { Proposal, ProposalRegistry } from './proposals'
import { ServerConfig } from './server-config'

const decisionSchema = z.object({ reason: z.string().max(500).optional() }).strict()

const same = (a: { iss: string; sub: string }, b: { iss: string; sub: string }) => a.iss === b.iss && a.sub === b.sub

// Whoever approves publishes it, and uses the accounts its proposer did not: a
// version that names an account is approved by somebody the account trusts.
export const mayApprove = (grant: Grant, proposal: Proposal): boolean =>
  mayPublish(grant) && proposal.missing.every((account) => canUse(grant, account))

// What the caller is shown of a proposal: what it is and who proposed it.
function toView(proposal: Proposal, principal: Principal, grant: Grant) {
  return {
    ...proposal,
    mine: same(proposal.proposedBy, principal),
    // approving needs the permission to publish, the accounts the proposer lacked, and
    // somebody else's proposal
    canDecide: proposal.state === 'waiting' && mayApprove(grant, proposal) && !same(proposal.proposedBy, principal),
  }
}

/**
 * New versions of build files that wait for an approval. Whoever may only
 * propose a version (`builds: propose`), or publishes one that names accounts they
 * do not use, puts one here; someone who may publish, and uses those accounts,
 * approves it, and it is published then.
 *
 *   GET  /v1/proposals                   the ones the caller proposed or may decide
 *   GET  /v1/proposals/<hash>            one of them
 *   GET  /v1/proposals/<hash>/files      its files, for who decides
 *   POST /v1/proposals/<hash>/approve    publish it (body: optional {reason})
 *   POST /v1/proposals/<hash>/reject     drop it
 */
export async function handleProposals(
  config: ServerConfig,
  store: DefinitionStore,
  proposals: ProposalRegistry,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/proposals(?:\/([^/]+)(?:\/(files|approve|reject))?)?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, hash, action] = match
  const grant = getGrant(config.entitlements, principal)
  // what the caller neither proposed nor may decide does not exist for them
  const visible = (proposal: Proposal) => same(proposal.proposedBy, principal) || mayPublish(grant)

  if (hash === undefined) {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return true
    }
    send(res, 200, {
      proposals: proposals
        .all()
        .filter(visible)
        .map((proposal) => toView(proposal, principal, grant)),
    })
    return true
  }
  if (!HASH_PATTERN.test(hash)) {
    send(res, 404, { error: 'not found' })
    return true
  }
  const proposal = proposals.get(hash)
  if (!action) {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return true
    }
    proposal && visible(proposal)
      ? send(res, 200, toView(proposal, principal, grant))
      : send(res, 404, { error: 'not found' })
    return true
  }
  if (action === 'files') {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return true
    }
    // the files are for who decides, and for who wrote them
    const bundle = proposal && visible(proposal) ? proposals.bundle(hash) : undefined
    bundle ? send(res, 200, bundle) : send(res, 404, { error: 'not found' })
    return true
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    return true
  }
  const body = decisionSchema.safeParse(req.headers['content-type'] ? await readJson(req) : {})
  if (!body.success) {
    const issue = body.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return true
  }
  const outcome = action === 'approve' ? 'approved' : 'rejected'
  try {
    const result = await proposals.decide(
      principal,
      hash,
      outcome,
      (proposed) => mayApprove(grant, proposed),
      async (bundle) => {
        const proposed = proposals.get(hash)
        await store.publish(bundle, proposed?.proposedBy ?? principal, {
          approvedBy: principal,
          annotations: proposed?.annotations,
        })
      },
      body.data.reason
    )
    log(
      `${action} proposal=${hash} iss=${principal.iss} sub=${principal.sub} result=${result.status}${
        body.data.reason ? ` reason=${quote(body.data.reason)}` : ''
      }`
    )
    switch (result.status) {
      case 'ok':
        send(res, 200, toView(result.proposal, principal, grant))
        break
      case 'own-proposal':
        send(res, 403, { error: 'a version is approved by somebody else than who proposed it' })
        break
      case 'not-waiting':
        send(res, 409, { error: `the proposal is ${result.state}, it does not wait for an approval` })
        break
      default:
        send(res, 404, { error: 'not found' })
    }
  } catch (e) {
    if (e instanceof DefinitionError) {
      send(res, 400, { error: `the build file does not load: ${e.message}` })
      return true
    }
    throw e
  }
  return true
}
