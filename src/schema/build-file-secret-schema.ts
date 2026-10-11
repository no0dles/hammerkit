import { boolean, object, string, z } from 'zod'

// A credential handed to a task or service without putting it in the build
// file, the cache or the logs: `from: env:NAME`, `from: file:path` or
// `from: <provider>:<ref>` (a secret provider, read as an account), injected
// as an env variable (`env`) or a read-only file (`path`). `cache: true` makes
// a salted digest of the value part of the task's cache key (ADR 0002).
export const buildFileSecretSchema = object({
  from: string().regex(/^[A-Za-z][A-Za-z0-9_-]*:.+$/, 'from must be env:NAME, file:path or <provider>:<ref>'),
  // the service account a provider secret is read as, else the task's or service's, else the default
  account: string().optional(),
  env: string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  path: string().optional(),
  cache: boolean().optional(),
})
  .strict()
  .refine((secret) => (secret.env === undefined) !== (secret.path === undefined), {
    message: 'a secret needs exactly one of env or path',
  })
  .describe('secret from env:NAME, file:path or <provider>:<ref>, injected as env or a read-only file')

export type BuildFileSecretSchema = z.infer<typeof buildFileSecretSchema>
