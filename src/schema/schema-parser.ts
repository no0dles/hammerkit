import { buildFileSchema } from './build-file-schema'
import { Environment } from '../executer/environment'
import { read } from '../parser/read-build-file'
import { BuildFileDirectory, ParseContext, ParseScope } from './parse-context'
import { dirname, join, relative } from 'path'
import { getBuildFilename } from '../parser/default-build-file'
import { ParseError } from './parse-error'
import { BuildFileGitSourceSchema, BuildFileIncludeSchema, isGitSource, isPublished } from './build-file-include-schema'
import { BuildFileSchema } from './build-file-schema'
import { isWithin, refreshGitSource, ResolvedGitSource, resolveGitSource } from '../includes/resolve-git-source'

export async function createParseContext(
  fileName: string,
  environment: Environment,
  options?: { refresh?: boolean; directory?: BuildFileDirectory; checkGitSource?: ParseContext['checkGitSource'] }
): Promise<{ ctx: ParseContext; scope: ParseScope }> {
  const ctx: ParseContext = {
    files: {},
    refreshed: options?.refresh ? new Map() : undefined,
    directory: options?.directory,
    checkGitSource: options?.checkGitSource,
  }

  const scope = await appendBuildFile(workDirectory(ctx, dirname(fileName)), ctx, environment, fileName, [])

  return { ctx, scope }
}

export async function appendBuildFile(
  cwd: string,
  ctx: ParseContext,
  environment: Environment,
  fileName: string,
  namePrefix: string[],
  remote?: ResolvedGitSource,
  inputs?: BuildFileEnvs,
  // on a server: the file is included with `publish: false`, or below such an include
  leftOut = false
): Promise<ParseScope> {
  const relativeName = namePrefix.join(':')
  // the same file included with other inputs is another set of tasks, and on a server a
  // file left out is another one than the same file published (its git sources differ)
  const key = `${cwd}:${fileName}${inputs ? `:${JSON.stringify(inputs)}` : ''}${leftOut ? ':left-out' : ''}`
  if (ctx.files[key]) {
    return ctx.files[key]
  }

  const input = await read(fileName, environment)
  const result = await buildFileSchema.safeParseAsync(input)
  if (!result.success) {
    throw new ParseError(result.error, fileName)
  }
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

  for (const block of ['references', 'includes'] as const) {
    for (const [name, include] of Object.entries(scope.schema[block] ?? {})) {
      if (scope.references[name]) {
        throw new Error(name + ' already exists')
      }
      const publish = isPublished(include)
      const type = block === 'references' ? 'reference' : 'include'
      // a server does not fetch what it leaves out: it doesn't run, and isn't checked
      const leaveOut = !!environment.hosted && (leftOut || !publish)
      if (isGitSource(include) && leaveOut) {
        scope.references[name] = { type, publish, scope: notFetched(cwd, [...namePrefix, name], include) }
        continue
      }
      if (isGitSource(include)) {
        ctx.checkGitSource?.(include, scope, block, name)
      }
      const target = await locateInclude(
        ctx,
        scope,
        include,
        block === 'references'
          ? // a remote file's paths resolve within its repository
            remote
            ? dirname(scope.fileName)
            : readDirectory(ctx, scope.cwd)
          : dirname(scope.fileName),
        environment
      )
      const targetScope = await appendBuildFile(
        // a reference works in its own directory, an include in the one of the including file
        block === 'references' ? workDirectory(ctx, dirname(target.fileName)) : cwd,
        ctx,
        environment,
        target.fileName,
        [...namePrefix, name],
        target.remote,
        target.inputs,
        leaveOut
      )
      scope.references[name] = { type, scope: targetScope, publish }
    }
  }

  return scope
}

// The scope of a git source a server does not fetch, see ParseScope.notFetched
function notFetched(cwd: string, namePrefix: string[], include: BuildFileGitSourceSchema): ParseScope {
  return {
    fileName: `${include.git}${include.path ? ` ${include.path}` : ''}`,
    cwd,
    schema: {},
    namePrefix: namePrefix.join(':'),
    references: {},
    notFetched: true,
  }
}

// The directory a build file works in, for the directory it was read from: the same
// one, unless the files were read from elsewhere (see BuildFileDirectory).
function workDirectory(ctx: ParseContext, directory: string): string {
  return ctx.directory ? moveDirectory(directory, ctx.directory.read, ctx.directory.work) : directory
}

// Where the build file of a directory it works in is read from.
function readDirectory(ctx: ParseContext, directory: string): string {
  return ctx.directory ? moveDirectory(directory, ctx.directory.work, ctx.directory.read) : directory
}

function moveDirectory(directory: string, from: string, to: string): string {
  return isWithin(from, directory) ? join(to, relative(from, directory)) : directory
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

  const local = typeof include === 'string' ? include : include.path
  const path = join(base, local)
  if (scope.remote && !isWithin(scope.remote.root, path)) {
    throw new Error(`${local} in ${scope.fileName} points outside ${scope.remote.git}`)
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
