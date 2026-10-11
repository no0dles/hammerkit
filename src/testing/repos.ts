import { RefError } from '../server/git-checkout'
import { RepoAccessOptions } from '../server/repo-access'

export const COMMIT = 'c'.repeat(40)
export const REPO = 'github.com/corp/payments'

// Repositories that exist only as names: every branch points to COMMIT, except
// `missing`, which is not there, and `both`, which is a branch and a tag.
export const fakeRepos: RepoAccessOptions = {
  resolve: async (_repo, ref) => {
    if (ref === 'missing') {
      throw new RefError(`there is no branch or tag ${ref}`)
    }
    if (ref === 'both') {
      throw new RefError(`${ref} is both a branch and a tag, name one of them`)
    }
    return COMMIT
  },
}

// the part of a server config that makes REPO readable
export const SOURCES_YAML = 'sources:\n  - match: github.com/corp/*\n'
