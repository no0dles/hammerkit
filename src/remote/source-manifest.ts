import { createHash } from 'crypto'
import { z } from 'zod'
import { isBundlePath } from './bundle'

// The files of a project that a run works on, as a list of what they are: a
// path, the sha-256 of the content and whether it is executable. The server
// keeps the content once per digest, so a client sends only what the server
// does not have yet, and the manifest names the whole tree by one hash.
export interface SourceFile {
  path: string
  sha256: string
  size: number
  // `exec` keeps the executable bit, a file is a plain file
  mode: 'file' | 'exec'
}

export interface SourceManifest {
  files: SourceFile[]
}

export const MAX_SOURCE_FILES = 20_000
export const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024
export const MAX_SOURCE_BYTES = 1024 * 1024 * 1024
// a manifest is about 200 bytes per file
export const MAX_MANIFEST_BODY_BYTES = 8 * 1024 * 1024

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/

const sourceFileSchema = z
  .object({
    path: z.string(),
    sha256: z.string().regex(DIGEST_PATTERN, 'expected 64 lowercase hex digits'),
    size: z.number().int().min(0).max(MAX_SOURCE_FILE_BYTES),
    mode: z.enum(['file', 'exec']).default('file'),
  })
  .strict()

export const sourceManifestSchema = z
  .object({ files: z.array(sourceFileSchema).min(1).max(MAX_SOURCE_FILES) })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>()
    let bytes = 0
    manifest.files.forEach((file, index) => {
      if (!isBundlePath(file.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: `"${file.path}" is not a path inside the project`,
        })
      }
      if (seen.has(file.path)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', index, 'path'], message: `${file.path} twice` })
      }
      seen.add(file.path)
      bytes += file.size
    })
    if (bytes > MAX_SOURCE_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: `more than ${MAX_SOURCE_BYTES} bytes` })
    }
  })

// The name of a tree: the sha-256 of the JSON `[[path, sha-256, mode], ...]` in
// path order. The same files have the same name wherever it is computed, and the
// size is not part of it because the content digest already decides it.
export function hashSource(manifest: SourceManifest): string {
  const files = [...manifest.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => [file.path, file.sha256, file.mode])
  return `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`
}

const DENIED_DIRECTORIES = ['.git', '.ssh', '.aws', '.gnupg', '.kube']
const DENIED_NAMES = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|dist$)/i,
  /^\.(npmrc|netrc|pypirc|dockercfg|git-credentials)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|p12|pfx)$/i,
]

// Files that hold credentials are not sent to a server even when a `src` pattern
// reaches them: a secret belongs in a secret provider, and a glob such as `**`
// must not be what decides that a key leaves the machine.
export function deniedSourcePath(path: string): string | null {
  const parts = path.split('/')
  const directory = parts.slice(0, -1).find((part) => DENIED_DIRECTORIES.includes(part))
  if (directory !== undefined) {
    return `${directory}/ holds credentials or history`
  }
  const name = parts[parts.length - 1]
  if (DENIED_NAMES.some((pattern) => pattern.test(name))) {
    return `${name} looks like a credential file`
  }
  return null
}
