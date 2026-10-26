import { BuildFileSchema } from './build-file-schema'
import { RefreshedGitSource, ResolvedGitSource } from '../includes/resolve-git-source'
import { BuildFileGitSourceSchema } from './build-file-include-schema'

export interface ParseContext {
  files: { [key: string]: ParseScope }
  // set by `includes pull`: git sources are fetched again instead of read from the
  // cache, once each, and recorded here
  refreshed?: Map<string, RefreshedGitSource>
  // set when the build files are read from somewhere else than where they work
  directory?: BuildFileDirectory
  // set by a server: called for each git source of a file of the bundle before it is
  // fetched, and throws to refuse it (see planBundle)
  checkGitSource?: (source: BuildFileGitSourceSchema, scope: ParseScope, block: string, name: string) => void
}

// Build files read from one directory and working in another: a server reads the
// published files from a directory of the run, and their tasks work on the files of a
// sandbox. A build file at `ci/build.yaml` below `read` works in `ci/` below `work`, and
// its references are read below `read` too. Remote includes keep their own directory.
export interface BuildFileDirectory {
  read: string
  work: string
}

export interface ParseScope {
  namePrefix: string
  schema: BuildFileSchema
  fileName: string
  cwd: string
  // set for a file that lives in a cached git checkout
  remote?: ResolvedGitSource
  // what the including file passed with `with`
  inputs?: NonNullable<BuildFileSchema['envs']>
  // `publish`: false when the including file says `publish: false`, see getPublishedFiles
  references: { [key: string]: { type: 'include' | 'reference'; scope: ParseScope; publish: boolean } }
  // on a server: a git source included with `publish: false` (or below one) is not
  // fetched, its scope is empty and what is named in it is not published
  notFetched?: boolean
}
