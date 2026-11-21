import { Principal } from './oauth'
import { canUse, getGrant } from './policy'
import { ServerConfig } from './server-config'
import { Run, RUN_ID_PATTERN, RunRegistry } from './runs'

// The accounts the caller uses: who approves a run on them follows and stops it.
export function accountsOf(config: ServerConfig, principal: Principal): (account: string) => boolean {
  const grant = getGrant(config.entitlements, principal)
  return (account) => canUse(grant, account)
}

/**
 * The run of `id` the caller may read: one they own or decided about (on an account they use),
 * or any run when an entitlement observes every run.
 */
export function findReadableRun(
  config: ServerConfig,
  registry: RunRegistry,
  principal: Principal,
  id: string
): Run | undefined {
  if (!RUN_ID_PATTERN.test(id)) {
    return undefined
  }
  const grant = getGrant(config.entitlements, principal)
  return registry.get(principal, id, accountsOf(config, principal)) ?? (grant.observe ? registry.peek(id) : undefined)
}
