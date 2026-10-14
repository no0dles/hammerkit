import { IncomingMessage, ServerResponse } from 'http'
import { send } from './http'
import { Principal } from './oauth'
import { getGrant, sandboxRepos } from './policy'
import { ServerConfig } from './server-config'

/**
 * Who the caller is and what they may do:
 *
 *   GET /v1/me         identity, accounts with their level, repositories, the builds level and sandbox repositories
 *   GET /v1/accounts   the accounts the caller has a level on, with what the operator says about them
 */
export async function handleAccounts(
  config: ServerConfig,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/v1/me' && url.pathname !== '/v1/accounts') {
    return false
  }
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    return true
  }
  const grant = getGrant(config.entitlements, principal)
  const accounts = Object.entries(grant.accounts)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, level]) => ({ name, level }))
  if (url.pathname === '/v1/me') {
    log(
      `grant iss=${principal.iss} sub=${principal.sub} accounts=[${accounts
        .map((account) => `${account.name}:${account.level}`)
        .join(',')}] entitlements=[${grant.matched.join(',')}]`
    )
    send(res, 200, {
      iss: principal.iss,
      sub: principal.sub,
      accounts,
      repos: grant.repos,
      builds: grant.builds,
      sandboxes: sandboxRepos(grant),
    })
    return true
  }
  send(res, 200, {
    accounts: accounts.map(({ name, level }) => ({
      name,
      ...(config.accounts[name]?.description ? { description: config.accounts[name].description } : {}),
      level,
      sources: config.accounts[name]?.source ?? ['upload', 'ref'],
    })),
  })
  return true
}
