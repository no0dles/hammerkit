import { boolean, z, object, string, union } from 'zod'
import { envsSchema } from './envs-schema'

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
  // overrides for the top-level `envs` the included file declares as its inputs
  with: envsSchema.optional(),
  publish: boolean().optional().describe('false: a server leaves out what this file declares'),
}).strict()

// A local path, with values for the inputs of the file it names like `with` of a git
// source (a value may pass on an `envs` value of the including file as `${NAME}`), and
// whether a server publishes what it declares.
export const buildFileLocalSourceSchema = object({
  path: string().min(1).describe('Build file or directory, relative to the including file'),
  with: envsSchema.optional(),
  publish: boolean().optional().describe('false: a server leaves out what this file declares'),
}).strict()

// A string is a local path; an object is a local path with options, or a git source (ADR-0004).
export const buildFileIncludeSchema = union([string(), buildFileLocalSourceSchema, buildFileGitSourceSchema])

export type BuildFileGitSourceSchema = z.infer<typeof buildFileGitSourceSchema>
export type BuildFileLocalSourceSchema = z.infer<typeof buildFileLocalSourceSchema>
export type BuildFileIncludeSchema = z.infer<typeof buildFileIncludeSchema>

export function isGitSource(include: BuildFileIncludeSchema): include is BuildFileGitSourceSchema {
  return typeof include !== 'string' && 'git' in include
}

// `publish: false`: what the file declares is left out of a version a server publishes
export function isPublished(include: BuildFileIncludeSchema): boolean {
  return typeof include === 'string' || include.publish !== false
}
