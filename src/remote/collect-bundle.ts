import { realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'path'
import { Environment } from '../executer/environment'
import { isWithin } from '../includes/resolve-git-source'
import { createParseContext } from '../schema/schema-parser'
import { Bundle, bundleSchema } from './bundle'

// The bundle of a build file on this machine: the file itself and every local
// file it includes or references, as the server reads them when it is published.
// The build file is read with the parser of a run, so what it pulls in is what a
// run would read. Git includes are not part of it (the server fetches them, at
// the commit they are pinned to), and neither is anything outside of the
// directory of the build file, which a server could not reproduce. That holds for
// where a file really is too: a link to a file outside of the directory is refused
// rather than followed, so publishing a checkout never sends a file of this machine
// that the checkout only points to.
// `missing` is what to do when there is no build file, said after that.
export async function collectBundle(
  fileName: string,
  environment: Environment,
  options: { missing?: string } = {}
): Promise<Bundle> {
  if (!(await environment.file.exists(fileName))) {
    throw new Error(`there is no build file at ${fileName}${options.missing ? `. ${options.missing}` : ''}`)
  }
  const entryPath = resolve(fileName)
  const root = dirname(entryPath)
  const { ctx } = await createParseContext(entryPath, environment)

  const paths = new Set<string>([entryPath])
  for (const scope of Object.values(ctx.files)) {
    if (!scope.remote) {
      paths.add(resolve(scope.fileName))
    }
  }

  const realRoot = await realpath(root)
  const files: Record<string, string> = {}
  for (const path of [...paths].sort()) {
    if (!isWithin(root, path)) {
      throw new Error(
        `${path} is outside of ${root}: a published build file can only include files below its own directory`
      )
    }
    if (!isWithin(realRoot, await realpath(path))) {
      throw new Error(
        `${path} links to a file outside of ${root}: a published build file can only include files below its own directory`
      )
    }
    files[relative(root, path).split(sep).join('/')] = await environment.file.read(path)
  }

  const result = bundleSchema.safeParse({ entry: relative(root, entryPath).split(sep).join('/'), files })
  if (!result.success) {
    throw new Error(`the build file can't be published: ${result.error.issues[0].message}`)
  }
  return result.data
}
