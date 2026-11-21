import type { Environment } from '../executer/environment'
import { isRunSourceEnv, RUN_SOURCE_ENVS, RunSourceEnv } from '../environment/run-source-envs'
import type { RunSource } from './runs'

export { RUN_SOURCE_ENVS }

// what of a source the variables are made of: a ref before it is pinned has no commit yet,
// a sandbox's id is known before its state is read
export type SourceOfRun =
  | (Omit<Extract<RunSource, { type: 'ref' }>, 'commit'> & { commit?: string })
  | Pick<Extract<RunSource, { type: 'sandbox' }>, 'type' | 'id' | 'repo'>
  | Pick<Extract<RunSource, { type: 'upload' }>, 'type'>

// a ref may name a commit, which is no branch or tag (see git-checkout.ts)
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

// What a run is from, for the `envs` of its tasks and services (`$HAMMERKIT_RUN_REF`): the
// repository, and the branch or tag and the commit it was pinned to, or the repository and the
// sandbox. None of them is a credential, so a task that reads them still takes arguments and
// keeps its network (see PLAIN_SERVER_ENVS). A sandbox has no commit: its files may hold
// changes. A run from an upload has none of them. Each is a name of RUN_SOURCE_ENVS.
export function runSourceEnvironment(source: SourceOfRun): { [name in RunSourceEnv]?: string } {
  if (source.type === 'ref') {
    return {
      HAMMERKIT_RUN_REPO: source.repo,
      ...(COMMIT.test(source.ref) ? {} : { HAMMERKIT_RUN_REF: source.ref }),
      ...(source.commit ? { HAMMERKIT_RUN_COMMIT: source.commit } : {}),
    }
  }
  if (source.type === 'sandbox') {
    return { HAMMERKIT_RUN_REPO: source.repo, HAMMERKIT_RUN_SANDBOX: source.id }
  }
  return {}
}

// The variables of a process, and the run's own in place of any of the same name, in any case.
export function withRunSource<T extends { [name: string]: string | undefined }>(
  envs: T,
  source: SourceOfRun
): { [name: string]: string | undefined } {
  const kept = Object.fromEntries(Object.entries(envs).filter(([name]) => !isRunSourceEnv(name)))
  return { ...kept, ...runSourceEnvironment(source) }
}

// The environment a run's files are read with, on the server, before its process starts: so
// the plan an approver reads shows what the tasks will see.
export function runPlanningEnvironment(environment: Environment, source: SourceOfRun): Environment {
  return { ...environment, processEnvs: withRunSource(environment.processEnvs, source) }
}
