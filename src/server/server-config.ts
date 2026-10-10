import { z } from 'zod'
import { parse } from 'yaml'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

export const serverPlatformSchema = z
  .object({
    os: z.enum(['linux', 'macos', 'windows']),
    arch: z.enum(['amd64', 'arm64']),
  })
  .strict()

// The server config is written by an operator and reviewed like code, so a typo
// is an error and not a silently ignored key.
export const serverConfigSchema = z
  .object({
    listen: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(0).max(65535).default(8480),
      })
      .strict()
      .default({}),
    // paths of a certificate and key
    tls: z
      .object({ cert: z.string().min(1), key: z.string().min(1) })
      .strict()
      .optional(),
    // plain http carries OAuth tokens, so it is only accepted on the loopback
    // interface, or when a proxy in front terminates TLS and this says so
    behindTlsProxy: z.boolean().default(false),
    // the OAuth issuers whose tokens the server accepts, and the audience those
    // tokens have to carry
    issuers: z
      .array(z.object({ issuer: z.string().url(), audience: z.string().min(1) }).strict())
      .min(1, 'at least one issuer is needed, OAuth is the only way to call the server'),
    backend: z
      .object({
        type: z.literal('host'),
        // what this machine offers; detected when left out
        platform: serverPlatformSchema.optional(),
      })
      .strict()
      .default({ type: 'host' }),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (!config.tls && !config.behindTlsProxy && !LOOPBACK_HOSTS.includes(config.listen.host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['listen', 'host'],
        message: `plain http on ${config.listen.host} would send tokens in the clear, set tls or behindTlsProxy: true`,
      })
    }
  })

export type ServerConfig = z.infer<typeof serverConfigSchema>
export type ServerPlatform = z.infer<typeof serverPlatformSchema>

export async function readServerConfig(environment: Environment, path: string): Promise<ServerConfig> {
  if (!(await environment.file.exists(path))) {
    throw new Error(`unable to read ${path}: no such file`)
  }
  let raw: unknown
  try {
    raw = parse(await environment.file.read(path))
  } catch (e) {
    throw new Error(`unable to read ${path}: ${getErrorMessage(e)}`)
  }
  const result = serverConfigSchema.safeParse(raw ?? {})
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    throw new Error(`invalid ${path}: ${where}${issue.message}`)
  }
  return result.data
}

export function detectPlatform(): ServerPlatform {
  const os = { darwin: 'macos', win32: 'windows' }[process.platform as string] ?? 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return { os, arch } as ServerPlatform
}
