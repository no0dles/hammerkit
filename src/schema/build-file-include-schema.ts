import { z, object, string, union } from 'zod'

// A repo URL or ref starting with `-` would be read by git as an option
// (`--upload-pack=…` runs a command), so neither may.
const notAnOption = (value: string) => !value.startsWith('-')

export const buildFileGitSourceSchema = object({
  git: string()
    .min(1)
    .refine(notAnOption, 'git must be a repository URL or path')
    .describe('Git repository URL or path'),
  // branch, tag or commit SHA; the repository's HEAD when omitted
  ref: string()
    .min(1)
    .refine(notAnOption, 'ref must be a branch, tag or commit SHA')
    .optional()
    .describe('Branch, tag or commit SHA, the repository HEAD when omitted'),
  // subpath of the build file or its directory within the repository
  path: string().optional().describe('Build file or directory within the repository'),
}).strict()

// A string is a local path; an object is a git source (ADR-0004).
export const buildFileIncludeSchema = union([string(), buildFileGitSourceSchema])

export type BuildFileGitSourceSchema = z.infer<typeof buildFileGitSourceSchema>
export type BuildFileIncludeSchema = z.infer<typeof buildFileIncludeSchema>

export function isGitSource(include: BuildFileIncludeSchema): include is BuildFileGitSourceSchema {
  return typeof include !== 'string'
}
