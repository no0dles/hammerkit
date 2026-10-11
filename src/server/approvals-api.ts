import { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { readJson, send } from './http'
import { Principal, quote } from './oauth'
import { canUse, getGrant } from './policy'
import { RUN_ID_PATTERN, Run, RunRegistry } from './runs'
import { ServerConfig } from './server-config'

const decisionSchema = z.object({ reason: z.string().max(500).optional() }).strict()

// What an approver is shown of a run: everything that decides whether to let it
// go ahead, and who asked.
function toApprovalView(run: Run) {
  return {
    id: run.id,
    state: run.state,
    requestedBy: run.owner,
    createdAt: run.createdAt,
    definition: run.definition,
    tasks: run.tasks,
    accounts: run.accounts,
    source: run.source,
    options: run.options,
    approvals: run.approvals,
  }
}

/**
 * The runs waiting for an approval, which somebody who uses the accounts they
 * need gives (one person is enough when they use all of them):
 *
 *   GET  /v1/approvals                  the runs the caller may approve
 *   GET  /v1/approvals/<id>             one of them
 *   POST /v1/approvals/<id>/approve     let it run (body: optional {reason})
 *   POST /v1/approvals/<id>/reject      end it
 *
 * What the caller may not approve does not exist for them; their own run is the
 * exception, they are told why it is not theirs to decide.
 */
export async function handleApprovals(
  config: ServerConfig,
  registry: RunRegistry,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/approvals(?:\/([^/]+)(?:\/(approve|reject))?)?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, id, action] = match
  const grant = getGrant(config.entitlements, principal)
  const canDecide = (account: string) => canUse(grant, account)

  if (!id) {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return true
    }
    const open = registry
      .waiting()
      .filter(
        (run) =>
          !(run.owner.iss === principal.iss && run.owner.sub === principal.sub) &&
          (run.approvals ?? []).some((approval) => !approval.approvedBy && canDecide(approval.account))
      )
    send(res, 200, { approvals: open.map(toApprovalView) })
    return true
  }
  if (!RUN_ID_PATTERN.test(id)) {
    send(res, 404, { error: 'not found' })
    return true
  }
  if (!action) {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return true
    }
    const run = registry.getForApproval(id, canDecide)
    run ? send(res, 200, toApprovalView(run)) : send(res, 404, { error: 'not found' })
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
  const result = registry.decide(principal, id, outcome, canDecide, body.data.reason)
  log(
    `${action} run=${id} iss=${principal.iss} sub=${principal.sub} result=${result.status}${
      body.data.reason ? ` reason=${quote(body.data.reason)}` : ''
    }`
  )
  switch (result.status) {
    case 'ok':
      send(res, 200, toApprovalView(result.run))
      break
    case 'own-run':
      send(res, 403, { error: 'a run is approved by somebody else than who asked for it' })
      break
    case 'not-waiting':
      send(res, 409, { error: `the run is ${result.state}, it does not wait for an approval` })
      break
    case 'already-approved':
      send(res, 409, { error: 'you approved all you can, the run waits for somebody who uses the other accounts' })
      break
    default:
      send(res, 404, { error: 'not found' })
  }
  return true
}
