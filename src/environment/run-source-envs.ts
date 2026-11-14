// The variables a server sets for the process of a run, from what the run is from (see
// src/server/run-source-environment.ts). Nothing else sets them: the operator's `runs.env`
// can't name them, and a run that isn't from that source has none of them.
export const RUN_SOURCE_ENVS = [
  'HAMMERKIT_RUN_REPO',
  'HAMMERKIT_RUN_REF',
  'HAMMERKIT_RUN_COMMIT',
  'HAMMERKIT_RUN_SANDBOX',
]

// without case: Windows doesn't tell `hammerkit_run_ref` from `HAMMERKIT_RUN_REF`
export function isRunSourceEnv(name: string): boolean {
  return RUN_SOURCE_ENVS.includes(name.toUpperCase())
}
