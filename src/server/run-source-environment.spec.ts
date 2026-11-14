import { describe, expect, it } from 'vitest'
import { runSourceEnvironment, withRunSource } from './run-source-environment'

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
      })
    ).toEqual({
      HAMMERKIT_RUN_REPO: 'github.com/corp/app',
      HAMMERKIT_RUN_SANDBOX: 'sbx_1',
    })
    expect(runSourceEnvironment({ type: 'upload' })).toEqual({})
  })

  it('names no ref when the ref is a commit, and no commit before the ref is pinned', () => {
    const commit = 'A'.repeat(40)
    expect(
      runSourceEnvironment({ type: 'ref', repo: 'github.com/corp/app', ref: commit, commit: 'a'.repeat(40) })
    ).toEqual({
      HAMMERKIT_RUN_REPO: 'github.com/corp/app',
      HAMMERKIT_RUN_COMMIT: 'a'.repeat(40),
    })
    expect(runSourceEnvironment({ type: 'ref', repo: 'github.com/corp/app', ref: 'main' })).toEqual({
      HAMMERKIT_RUN_REPO: 'github.com/corp/app',
      HAMMERKIT_RUN_REF: 'main',
    })
  })

  it('takes the place of the same names of the process, in any case', () => {
    const envs = withRunSource(
      { PATH: '/bin', HAMMERKIT_RUN_SANDBOX: 'from-operator', hammerkit_run_ref: 'from-operator' },
      { type: 'ref', repo: 'github.com/corp/app', ref: 'main', commit: 'a'.repeat(40) }
    )
    expect(envs).toEqual({
      PATH: '/bin',
      HAMMERKIT_RUN_REPO: 'github.com/corp/app',
      HAMMERKIT_RUN_REF: 'main',
      HAMMERKIT_RUN_COMMIT: 'a'.repeat(40),
    })
    expect(withRunSource({ HAMMERKIT_RUN_REPO: 'x', HAMMERKIT_RUN_COMMIT: 'y' }, { type: 'upload' })).toEqual({})
  })
})
