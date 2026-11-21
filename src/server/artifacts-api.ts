import { IncomingMessage, ServerResponse } from 'http'
import { pipeline } from 'stream/promises'
import { send } from './http'
import { Principal } from './oauth'
import { ServerConfig } from './server-config'
import { ArtifactStore } from './run-artifacts'
import { findReadableRun } from './run-access'
import { isFinal, RunRegistry } from './runs'

/**
 * The outputs a run's tasks exported, kept by the server once the run ended (ArtifactStore):
 *
 *   GET /v1/runs/<id>/artifacts       what it kept, by number, until when, or why it kept none
 *   GET /v1/runs/<id>/artifacts/<n>   one of them, a gzipped tar of its paths in the project
 *
 * Who may read the run's log may read them (its owner, who decided about it, `observe`): a
 * task could print what it writes there into its log all the same. What a credential can
 * reach is never kept (refuseArtifacts).
 */
export async function handleArtifacts(
  config: ServerConfig,
  registry: RunRegistry,
  artifacts: ArtifactStore,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  now: () => number
): Promise<boolean> {
  const match = /^\/v1\/runs\/([^/]+)\/artifacts(?:\/([^/]+))?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, id, output] = match
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    return true
  }
  const run = findReadableRun(config, registry, principal, id)
  if (!run || (output !== undefined && !/^\d{1,6}$/.test(output))) {
    send(res, 404, { error: 'not found' })
    return true
  }
  if (!isFinal(run.state)) {
    send(res, 409, { error: `the run is ${run.state}, what it keeps is there once it ended` })
    return true
  }
  if (output === undefined) {
    send(res, 200, await artifacts.read(run, now()))
    return true
  }
  const opened = await artifacts.open(run, Number(output), now())
  if (!opened) {
    send(res, 404, { error: 'not found' })
    return true
  }
  log(`artifacts iss=${principal.iss} sub=${principal.sub} run=${run.id} output=${output}`)
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-length': String(opened.bytes),
    'cache-control': 'no-store',
  })
  await pipeline(opened.stream(), res).catch(() => res.destroy())
  return true
}
