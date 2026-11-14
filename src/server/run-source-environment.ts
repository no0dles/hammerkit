import type { RunSource } from './runs'

// What a run is from, for the `envs` of its tasks (`$HAMMERKIT_RUN_REF`): the repository, the
// ref and the commit it was pinned to, or the sandbox. None of them is a credential, so a task
// that reads them still takes arguments and keeps its network (see PLAIN_SERVER_ENVS). They are
// set after the operator's `runs.env`, which can't change them. A run from an upload has none.
export const RUN_SOURCE_ENVS = [
  'HAMMERKIT_RUN_REPO',
  'HAMMERKIT_RUN_REF',
  'HAMMERKIT_RUN_COMMIT',
  'HAMMERKIT_RUN_SANDBOX',
]

export function runSourceEnvironment(source: RunSource): { [name: string]: string } {
  if (source.type === 'ref') {
    return { HAMMERKIT_RUN_REPO: source.repo, HAMMERKIT_RUN_REF: source.ref, HAMMERKIT_RUN_COMMIT: source.commit }
  }
  if (source.type === 'sandbox') {
    return { HAMMERKIT_RUN_REPO: source.repo, HAMMERKIT_RUN_COMMIT: source.commit, HAMMERKIT_RUN_SANDBOX: source.id }
  }
  return {}
}
