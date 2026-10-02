import { dirname, join } from 'path'
import { Environment } from '../executer/environment'

// The project root anchors cache identity: every path that participates in a
// task or service id is expressed relative to it, so the same checkout yields the
// same ids wherever it lives (an agent sandbox, a CI runner, a laptop). The git
// root is used when there is one, so the root does not move with the build file
// the CLI was invoked with (`-f apps/web/.hammerkit.yaml` vs the repo root);
// otherwise the directory of the main build file.
export async function findProjectRoot(buildFileDirectory: string, environment: Environment): Promise<string> {
  let current = buildFileDirectory
  for (;;) {
    // `.git` is a directory in a normal clone and a file in a worktree/submodule
    if (await environment.file.exists(join(current, '.git'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return buildFileDirectory
    }
    current = parent
  }
}
