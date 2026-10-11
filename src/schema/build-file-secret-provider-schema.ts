import { array, boolean, object, record, string, z } from 'zod'
import { durationSchema } from './duration-schema'

// `env` and `file` are the built-in sources of `from`, so a provider cannot take
// either name.
export const RESERVED_SECRET_PROVIDERS = ['env', 'file']

const nameSchema = string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'a name starts with a letter and holds letters, digits, - and _')
  .refine((name) => !RESERVED_SECRET_PROVIDERS.includes(name), 'env and file are built-in secret sources')

// How to fetch a secret: a command that prints the value to stdout (ADR 0008).
// The command is an argv list, never run through a shell. `{{ref}}` is replaced
// by the text after `provider:` in a secret's `from`. It holds no credential:
// those come from the account the secret is read as.
export const buildFileSecretProviderSchema = object({
  command: array(string())
    .min(1)
    .describe('command and arguments, no shell; {{ref}} is replaced by the secret reference'),
  env: record(string()).optional().describe('static environment of the command, next to PATH and the account env'),
  timeout: durationSchema.optional().describe('how long the command may run, 30s when omitted'),
})
  .strict()
  .describe('secret provider, a command that prints the secret to stdout')

// As whom a provider is read: the environment its command runs with. Values
// are `${HOST_VARIABLE}` references to a credential the machine running
// hammerkit holds, so a build file never carries one.
export const buildFileSecretAccountSchema = object({
  default: boolean().optional().describe('the account for secrets and tasks that name none'),
  providers: record(nameSchema, object({ env: record(string()) }).strict()).describe(
    'per provider, the environment that makes its command act as this account'
  ),
})
  .strict()
  .describe('service account the secret providers are read as')

export const buildFileSecretProvidersSchema = record(nameSchema, buildFileSecretProviderSchema)
export const buildFileSecretAccountsSchema = record(nameSchema, buildFileSecretAccountSchema)

export type BuildFileSecretProviderSchema = z.infer<typeof buildFileSecretProviderSchema>
export type BuildFileSecretAccountSchema = z.infer<typeof buildFileSecretAccountSchema>
