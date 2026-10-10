import { buildFileSchema } from './build-file-schema'
import { Environment } from '../executer/environment'
import { read } from '../parser/read-build-file'
import { ParseContext, ParseScope } from './parse-context'
import { dirname, join } from 'path'
import { getBuildFilename } from '../parser/default-build-file'
import { ParseError } from './parse-error'
import { BuildFileGitSourceSchema, BuildFileIncludeSchema, isGitSource } from './build-file-include-schema'
import { BuildFileSchema } from './build-file-schema'
import { isWithin, refreshGitSource, ResolvedGitSource, resolveGitSource } from '../includes/resolve-git-source'

export async function createParseContext(
  fileName: string,
  environment: Environment,
  options?: { refresh?: boolean }
): Promise<{ ctx: ParseContext; scope: ParseScope }> {
  const ctx: ParseContext = {
    files: {},
    refreshed: options?.refresh ? new Map() : undefined,
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
  remote?: ResolvedGitSource,
  inputs?: BuildFileEnvs
): Promise<ParseScope> {
  const relativeName = namePrefix.join(':')
  // the same file included with other inputs is another set of tasks
  const key = inputs ? `${cwd}:${fileName}:${JSON.stringify(inputs)}` : `${cwd}:${fileName}`
  if (ctx.files[key]) {
    return ctx.files[key]
  }

  const input = await read(fileName, environment)
  const result = await buildFileSchema.safeParseAsync(input)
  if (result.success) {
    const scope: ParseScope = {
      fileName,
      cwd,
      schema: inputs ? applyInputs(result.data, inputs, namePrefix, fileName) : result.data,
      namePrefix: relativeName,
      remote,
      inputs,
      references: {},
    }
    ctx.files[key] = scope

    if (scope.schema.references) {
      for (const referenceName of Object.keys(scope.schema.references)) {
        const target = await locateInclude(
          ctx,
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
          target.remote,
          target.inputs
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
          ctx,
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
          target.remote,
          target.inputs
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
  ctx: ParseContext,
  scope: ParseScope,
  include: BuildFileIncludeSchema,
  base: string,
  environment: Environment
): Promise<{ fileName: string; remote?: ResolvedGitSource; inputs?: BuildFileEnvs }> {
  if (isGitSource(include)) {
    const remote = await resolveRemote(ctx, include, environment)
    const path = join(remote.root, include.path ?? '')
    if (!isWithin(remote.root, path)) {
      throw new Error(`${include.path} in ${include.git} points outside the repository`)
    }
    return { fileName: await getBuildFilename(path, environment), remote, inputs: include.with }
  }

  const path = join(base, include)
  if (scope.remote && !isWithin(scope.remote.root, path)) {
    throw new Error(`${include} in ${scope.fileName} points outside ${scope.remote.git}`)
  }
  return { fileName: await getBuildFilename(path, environment), remote: scope.remote }
}

// `includes pull` fetches each source once, however often the build files name it.
async function resolveRemote(
  ctx: ParseContext,
  source: BuildFileGitSourceSchema,
  environment: Environment
): Promise<ResolvedGitSource> {
  const key = `${source.git}\n${source.ref ?? ''}`
  if (!ctx.refreshed || ctx.refreshed.has(key)) {
    return resolveGitSource(source, environment)
  }
  ctx.refreshed.set(key, await refreshGitSource(source, environment))
  return resolveGitSource(source, environment)
}

type BuildFileEnvs = NonNullable<BuildFileSchema['envs']>

// The top-level `envs` of an included file are its inputs: it declares each one
// with a default, and `with` replaces the default. A name the file does not
// declare is rejected, so a typo cannot silently do nothing.
function applyInputs(
  schema: BuildFileSchema,
  inputs: BuildFileEnvs,
  namePrefix: string[],
  fileName: string
): BuildFileSchema {
  const declared = Object.keys(schema.envs ?? {})
  for (const name of Object.keys(inputs)) {
    if (!declared.includes(name)) {
      const available = declared.length > 0 ? `available inputs: ${declared.join(', ')}` : 'it declares no inputs'
      throw new Error(`unknown input ${name} for ${namePrefix.join(':')} (${fileName}), ${available}`)
    }
  }
  return { ...schema, envs: { ...schema.envs, ...inputs } }
}
