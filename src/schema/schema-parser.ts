import { buildFileSchema } from './build-file-schema'
import { Environment } from '../executer/environment'
import { read } from '../parser/read-build-file'
import { ParseContext, ParseScope } from './parse-context'
import { dirname, join } from 'path'
import { getBuildFilename } from '../parser/default-build-file'

export async function createParseContext(
  fileName: string,
  environment: Environment
): Promise<{ ctx: ParseContext; scope: ParseScope }> {
  const ctx: ParseContext = {
    files: {},
  }

  const scope = await appendBuildFile(ctx, environment, fileName, [])

  return { ctx, scope }
}

export async function appendBuildFile(
  ctx: ParseContext,
  environment: Environment,
  fileName: string,
  namePrefix: string[]
): Promise<ParseScope> {
  if (ctx.files[fileName]) {
    return ctx.files[fileName]
  }

  const input = await read(fileName, environment)
  const result = await buildFileSchema.safeParseAsync(input)
  if (result.success) {
    const scope: ParseScope = {
      fileName,
      cwd: dirname(fileName),
      schema: result.data,
      namePrefix: namePrefix.join(':'),
      references: {},
    }
    ctx.files[fileName] = scope

    if (scope.schema.references) {
      for (const referenceName of Object.keys(scope.schema.references)) {
        const reference = scope.schema.references[referenceName]
        const referenceFilename = await getBuildFilename(join(scope.cwd, reference), environment)
        const referenceScope = await appendBuildFile(ctx, environment, referenceFilename, [
          ...namePrefix,
          referenceName,
        ])
        if (scope.references[referenceName]) {
          throw new Error(referenceName + ' already exists')
        }
        scope.references[referenceName] = { type: 'reference', scope: referenceScope }
      }
    }

    if (scope.schema.includes) {
      for (const includeName of Object.keys(scope.schema.includes)) {
        const include = scope.schema.includes[includeName]
        const includeFilename = await getBuildFilename(join(scope.cwd, include), environment)
        const includeScope = await appendBuildFile(ctx, environment, includeFilename, [...namePrefix, includeName])
        if (scope.references[includeName]) {
          throw new Error(includeName + ' already exists')
        }
        scope.references[includeName] = { type: 'include', scope: includeScope }
      }
    }

    return scope
  } else {
    throw result.error
  }
}
