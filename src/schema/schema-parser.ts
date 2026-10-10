import { buildFileSchema } from './build-file-schema'
import { Environment } from '../executer/environment'
import { read } from '../parser/read-build-file'
import { ParseContext, ParseScope } from './parse-context'
import { dirname, join } from 'path'
import { getBuildFilename } from '../parser/default-build-file'
import { ParseError } from './parse-error'
import { BuildFileIncludeSchema, isGitSource } from './build-file-include-schema'
import { isWithin, ResolvedGitSource, resolveGitSource } from '../includes/resolve-git-source'

export async function createParseContext(
  fileName: string,
  environment: Environment
): Promise<{ ctx: ParseContext; scope: ParseScope }> {
  const ctx: ParseContext = {
    files: {},
  }

  const scope = await appendBuildFile(dirname(fileName), ctx, environment, fileName, [])

  return { ctx, scope }
}

export async function appendBuildFile(
  cwd: string,
  ctx: ParseContext,
  environment: Environment,
  fileName: string,
  namePrefix: string[],
  remote?: ResolvedGitSource
): Promise<ParseScope> {
  const relativeName = namePrefix.join(':')
  const key = `${cwd}:${fileName}`
  if (ctx.files[key]) {
    return ctx.files[key]
  }

  const input = await read(fileName, environment)
  const result = await buildFileSchema.safeParseAsync(input)
  if (result.success) {
    const scope: ParseScope = {
      fileName,
      cwd,
      schema: result.data,
      namePrefix: relativeName,
      remote,
      references: {},
    }
    ctx.files[key] = scope

    if (scope.schema.references) {
      for (const referenceName of Object.keys(scope.schema.references)) {
        const target = await locateInclude(
          scope,
          scope.schema.references[referenceName],
          // a remote file's paths resolve within its repository
          remote ? dirname(scope.fileName) : scope.cwd,
          environment
        )
        const referenceScope = await appendBuildFile(
          dirname(target.fileName),
          ctx,
          environment,
          target.fileName,
          [...namePrefix, referenceName],
          target.remote
        )
        if (scope.references[referenceName]) {
          throw new Error(referenceName + ' already exists')
        }
        scope.references[referenceName] = { type: 'reference', scope: referenceScope }
      }
    }

    if (scope.schema.includes) {
      for (const includeName of Object.keys(scope.schema.includes)) {
        const target = await locateInclude(
          scope,
          scope.schema.includes[includeName],
          dirname(scope.fileName),
          environment
        )
        const includeScope = await appendBuildFile(
          cwd,
          ctx,
          environment,
          target.fileName,
          [...namePrefix, includeName],
          target.remote
        )
        if (scope.references[includeName]) {
          throw new Error(includeName + ' already exists')
        }
        scope.references[includeName] = { type: 'include', scope: includeScope }
      }
    }

    return scope
  } else {
    throw new ParseError(result.error, fileName)
  }
}

// A string is a local path below `base`; an object is a git source, fetched once
// into the include cache. Inside a cached checkout a local path may not leave it:
// a remote file contributes definitions from its own repository only.
async function locateInclude(
  scope: ParseScope,
  include: BuildFileIncludeSchema,
  base: string,
  environment: Environment
): Promise<{ fileName: string; remote?: ResolvedGitSource }> {
  if (isGitSource(include)) {
    const remote = await resolveGitSource(include, environment)
    const path = join(remote.root, include.path ?? '')
    if (!isWithin(remote.root, path)) {
      throw new Error(`${include.path} in ${include.git} points outside the repository`)
    }
    return { fileName: await getBuildFilename(path, environment), remote }
  }

  const path = join(base, include)
  if (scope.remote && !isWithin(scope.remote.root, path)) {
    throw new Error(`${include} in ${scope.fileName} points outside ${scope.remote.git}`)
  }
  return { fileName: await getBuildFilename(path, environment), remote: scope.remote }
}
