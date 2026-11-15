import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { HostConfig, HostServer, hasServer, notRegisteredMessage, readHostConfig } from './host-config'

export interface LocationOptions {
  // --on <name>
  on?: string
  // --local
  local?: boolean
}

export type RunLocation = { type: 'local' } | { type: 'server'; name: string; server: HostServer }

// Where a run happens, highest precedence first: --on / --local, HAMMERKIT_ON,
// the runner of the tasks, `run.on` of the host config, local. `auto` (as
// --on, HAMMERKIT_ON or run.on) means the runner of the tasks, else local.
// A name that is not registered is an error: a run never falls back to the
// local machine silently.
export async function resolveRunLocation(
  workTree: WorkTree,
  environment: Environment,
  options: LocationOptions = {}
): Promise<RunLocation> {
  if (options.on && options.local) {
    throw new Error('--on and --local contradict each other')
  }

  const config = await readHostConfig(environment)
  const explicit = options.local ? 'local' : options.on ?? (environment.processEnvs.HAMMERKIT_ON || undefined)
  if (explicit && explicit !== 'auto') {
    return explicit === 'local' ? { type: 'local' } : lookup(config, explicit)
  }

  const runners = getTaskRunners(workTree)
  if (runners.length > 1) {
    throw new Error(`a run goes to one server, but its tasks name ${runners.join(', ')}`)
  }
  const requested = runners[0] ?? (explicit ? undefined : config.run.on)
  if (!requested || requested === 'local' || requested === 'auto') {
    return { type: 'local' }
  }
  return lookup(config, requested)
}

function lookup(config: HostConfig, name: string): RunLocation {
  const server = hasServer(config.servers, name) ? config.servers[name] : undefined
  if (!server) {
    throw new Error(notRegisteredMessage(config, name))
  }
  return { type: 'server', name, server }
}

function getTaskRunners(workTree: WorkTree): string[] {
  const runners = new Set<string>()
  for (const task of Object.values(workTree.tasks)) {
    if (task.data.runner) {
      runners.add(task.data.runner)
    }
  }
  return [...runners].sort()
}
