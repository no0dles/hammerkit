import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join, relative, isAbsolute } from 'path'
import { promisify } from 'util'
import { Environment } from '../executer/environment'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { BuildFileGitSourceSchema } from '../schema/build-file-include-schema'

const execFileAsync = promisify(execFile)

// A remote reference after resolution: the checkout (`root`) and the commit it
// holds. Relative paths of a file inside it resolve within `root` (FR-005).
export interface ResolvedGitSource {
  git: string
  ref: string | null
  commit: string
  root: string
}

interface StoredSource {
  git: string
  ref: string | null
  commit: string
}

// Anything but plain network and local transports is refused: `ext::` runs a
// command, and a remote build file can name any repository.
const ALLOWED_PROTOCOLS = 'file:git:http:https:ssh'

export function getIncludesDirectory(): string {
  return join(getHammerkitDirectory(), 'includes')
}

function getSourceKey(source: BuildFileGitSourceSchema): string {
  return createHash('sha256')
    .update(`${source.git}\n${source.ref ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

export function describeGitSource(source: { git: string; ref?: string | null }): string {
  return `${source.git} at ${source.ref ?? 'HEAD'}`
}

// The cache is the pin (ADR-0004): a source that was resolved once is served from
// disk, offline too, until it is refreshed or purged. Only a source that was
// never resolved needs the network.
export async function resolveGitSource(
  source: BuildFileGitSourceSchema,
  environment: Environment
): Promise<ResolvedGitSource> {
  const directory = join(getIncludesDirectory(), getSourceKey(source))
  const cached = await readCached(directory)
  if (cached) {
    return cached
  }

  await mkdir(getIncludesDirectory(), { recursive: true })
  const staging = `${directory}.${randomUUID()}`
  try {
    await mkdir(staging, { recursive: true })
    const commit = await fetchInto(join(staging, 'repo'), source, environment)
    const stored: StoredSource = { git: source.git, ref: source.ref ?? null, commit }
    await writeFile(join(staging, 'source.json'), JSON.stringify(stored, null, 2))
    try {
      await rename(staging, directory)
    } catch (e) {
      // a parallel run resolved the same source first; both hold the same ref
      const winner = await readCached(directory)
      if (!winner) {
        throw e
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  const resolved = await readCached(directory)
  if (!resolved) {
    throw new Error(`unable to cache ${describeGitSource(source)}`)
  }
  return resolved
}

async function readCached(directory: string): Promise<ResolvedGitSource | null> {
  try {
    const stored: StoredSource = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8'))
    return { git: stored.git, ref: stored.ref, commit: stored.commit, root: join(directory, 'repo') }
  } catch {
    return null
  }
}

async function fetchInto(repo: string, source: BuildFileGitSourceSchema, environment: Environment): Promise<string> {
  await git(['init', '--quiet', repo], source, environment)
  await git(
    ['-C', repo, 'fetch', '--quiet', '--depth', '1', '--', source.git, source.ref ?? 'HEAD'],
    source,
    environment
  )
  await git(['-C', repo, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'], source, environment)
  const { stdout } = await git(['-C', repo, 'rev-parse', 'HEAD'], source, environment)
  return stdout.trim()
}

async function git(args: string[], source: BuildFileGitSourceSchema, environment: Environment) {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(environment.processEnvs)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  // credentials come from the user's git configuration and helpers; there is no
  // interactive prompt a build could hang on
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ALLOW_PROTOCOL = ALLOWED_PROTOCOLS

  try {
    return await execFileAsync('git', args, { env, signal: environment.abortCtrl.signal })
  } catch (e) {
    const error = e as NodeJS.ErrnoException & { stderr?: string }
    if (error.code === 'ENOENT') {
      throw new Error(`unable to resolve ${describeGitSource(source)}: git is not installed`)
    }
    const reason =
      (error.stderr ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop() ?? error.message
    throw new Error(`unable to resolve ${describeGitSource(source)}: ${reason}`)
  }
}

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !rel.startsWith('..') && !isAbsolute(rel)
}
