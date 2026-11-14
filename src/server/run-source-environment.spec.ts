import { describe, expect, it } from 'vitest'
import { runSourceEnvironment } from './run-source-environment'

describe('the environment of a run from its source', () => {
  it('names the repository, ref and commit of a ref, the sandbox of a sandbox, nothing of an upload', () => {
    expect(
      runSourceEnvironment({ type: 'ref', repo: 'github.com/corp/app', ref: 'feature/x', commit: 'a'.repeat(40) })
    ).toEqual({
      HAMMERKIT_RUN_REPO: 'github.com/corp/app',
      HAMMERKIT_RUN_REF: 'feature/x',
      HAMMERKIT_RUN_COMMIT: 'a'.repeat(40),
    })
    expect(
      runSourceEnvironment({
        type: 'sandbox',
        id: 'sbx_1',
        repo: 'github.com/corp/app',
        commit: 'b'.repeat(40),
        tree: 'c'.repeat(40),
      })
    ).toEqual({
      HAMMERKIT_RUN_REPO: 'github.com/corp/app',
      HAMMERKIT_RUN_COMMIT: 'b'.repeat(40),
      HAMMERKIT_RUN_SANDBOX: 'sbx_1',
    })
    expect(runSourceEnvironment({ type: 'upload', snapshot: 's' })).toEqual({})
  })
})
