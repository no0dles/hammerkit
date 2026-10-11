import { createHash } from 'crypto'
import { z } from 'zod'

// A build file as the server keeps it: the file that starts it and every file it
// includes, as text. Nothing outside of it is read when it is published or run,
// so its hash names exactly what will be executed.
export interface Bundle {
  entry: string
  files: Record<string, string>
}

export const DEFAULT_ENTRY = '.hammerkit.yaml'
export const MAX_BUNDLE_FILES = 200
export const MAX_BUNDLE_BYTES = 1024 * 1024

// A path inside the bundle: relative, forward slashes, nothing that climbs out.
export function isBundlePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 200 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}

export const bundleSchema = z
  .object({
    entry: z.string().default(DEFAULT_ENTRY),
    files: z.record(z.string()),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const paths = Object.keys(bundle.files)
    const bad = paths.find((path) => !isBundlePath(path))
    if (bad !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: `"${bad}" is not a path inside the bundle`,
      })
    }
    if (paths.length > MAX_BUNDLE_FILES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: `more than ${MAX_BUNDLE_FILES} files` })
    }
    const bytes = paths.reduce((sum, path) => sum + Buffer.byteLength(bundle.files[path]), 0)
    if (bytes > MAX_BUNDLE_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: `larger than ${MAX_BUNDLE_BYTES} bytes` })
    }
    if (!isBundlePath(bundle.entry) || !Object.prototype.hasOwnProperty.call(bundle.files, bundle.entry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entry'], message: `${bundle.entry} is not one of the files` })
    }
  })

// The version of a bundle: the hash of its entry and of every file, in path order,
// so the same files always have the same version, wherever it is computed. It is
// the sha-256 of the JSON `[entry, [[path, sha-256 of the content], ...]]`.
export function hashBundle(bundle: Bundle): string {
  const files = Object.keys(bundle.files)
    .sort()
    .map((path) => [path, createHash('sha256').update(bundle.files[path]).digest('hex')])
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([bundle.entry, files]))
    .digest('hex')}`
}

export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
