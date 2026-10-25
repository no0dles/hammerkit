import { SandboxClient } from './sandbox-client'
import type { Run } from '../server/runs'

// the most of a page an agent gets back
const MAX_PAGE_CHARS = 20_000

/**
 * The tools of the harnesses for service runs: start services of the build file with their
 * endpoints, for a person to look at, read a page of one, and take them down. Each harness
 * has the same three in its own shape: the parameters are strings and lists of strings, which
 * every schema of them says.
 */
export interface ServiceTool {
  name: string
  title: string
  description: string
  parameters: { [name: string]: { type: 'string' | 'string[]'; description: string } }
  required: string[]
  call(client: SandboxClient, args: any, signal: AbortSignal): Promise<string>
}

// The parameters as a JSON schema, for MCP, pi and opencode 2.
export function serviceToolSchema(tool: ServiceTool): {
  type: 'object'
  properties: { [name: string]: unknown }
  required: string[]
} {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(tool.parameters).map(([name, parameter]) => [
        name,
        parameter.type === 'string'
          ? { type: 'string', description: parameter.description }
          : { type: 'array', items: { type: 'string' }, description: parameter.description },
      ])
    ),
    required: tool.required,
  }
}

// The parameters with the zod of opencode 1.
export function serviceToolArgs(tool: ServiceTool, z: any): { [name: string]: unknown } {
  return Object.fromEntries(
    Object.entries(tool.parameters).map(([name, parameter]) => {
      const type = parameter.type === 'string' ? z.string() : z.array(z.string())
      return [name, (tool.required.includes(name) ? type : type.optional()).describe(parameter.description)]
    })
  )
}

// `web:8080` as the server takes an endpoint
export function parseEndpoint(value: string): { service: string; port: number } {
  const index = value.lastIndexOf(':')
  const port = Number(value.slice(index + 1))
  if (index <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${value} is not an endpoint, write it as service:port, such as web:8080`)
  }
  return { service: value.slice(0, index), port }
}

// How a service run stands, for an agent: where its endpoints are and until when.
export function describeServiceRun(run: Run): string {
  const lines = [`run ${run.id}: ${run.state}${run.up ? ` (${run.up.name})` : ''}`]
  if (run.state === 'up') {
    lines.push(`up until ${run.expiresAt}, stop it with services_stop when it is no longer needed`)
    for (const endpoint of run.up?.endpoints ?? []) {
      lines.push(`${endpoint.service}:${endpoint.port} -> ${endpoint.url}`)
    }
    if ((run.up?.endpoints ?? []).length > 0) {
      lines.push('a person opens these addresses in a browser and signs in; read a page yourself with endpoint_get')
    }
  } else if (run.error) {
    lines.push(`error: ${run.error}`)
  }
  for (const [task, result] of Object.entries(run.results ?? {})) {
    if (result.status === 'failed') {
      lines.push(`${task} failed${result.error ? `: ${result.error}` : ''}`, ...result.lastLog)
    }
  }
  if (run.state !== 'up') {
    lines.push(`read the log with run_logs { "run": "${run.id}" }`)
  }
  return lines.join('\n')
}

export const SERVICE_TOOLS: ServiceTool[] = [
  {
    name: 'services_up',
    title: 'Start services',
    description:
      'Start services of the published build file on the hammerkit server, with the files of the sandbox (or of ' +
      'a branch), and keep them up for a person to look at: each endpoint (service:port) gets an address of its ' +
      'own behind the sign-in of the server. Answers once they are up, with the addresses and until when they ' +
      'stay. A second start with the same name replaces the first, so its addresses stay the same.',
    parameters: {
      services: { type: 'string[]', description: 'The services to start, as the build file names them' },
      endpoints: { type: 'string[]', description: 'The ports to publish, as service:port, such as web:8080' },
      ttl: {
        type: 'string',
        description: 'How long they stay up once ready, such as 2h; the server default when left out',
      },
      name: {
        type: 'string',
        description: 'Lower case letters, digits and -; the addresses carry it. The branch when left out',
      },
      branch: {
        type: 'string',
        description: 'Start from this pushed branch of the repository instead of the files of the sandbox',
      },
    },
    required: ['services'],
    async call(client, args, signal) {
      const followed = await client.up(
        {
          services: args.services,
          endpoints: (args.endpoints ?? []).map(parseEndpoint),
          ttl: args.ttl || undefined,
          name: args.name || undefined,
          branch: args.branch || undefined,
        },
        { signal }
      )
      return describeServiceRun(followed.run)
    },
  },
  {
    name: 'endpoint_get',
    title: 'Read a page of an endpoint',
    description:
      'GET a path of an endpoint of a service run started with services_up, signed in as you, and answer its ' +
      'status and body: to check that the app answers before a person opens it.',
    parameters: {
      run: { type: 'string', description: 'The id of the service run' },
      path: { type: 'string', description: 'The path, such as / or /api/health' },
      service: { type: 'string', description: 'The service of the endpoint, the first endpoint when left out' },
    },
    required: ['run', 'path'],
    async call(client, args, signal) {
      const page = await client.fetchEndpoint(args.run, args.path, args.service || undefined, signal)
      const body =
        page.body.length > MAX_PAGE_CHARS
          ? `${page.body.slice(0, MAX_PAGE_CHARS)}\n… (${
              page.body.length
            } characters, the first ${MAX_PAGE_CHARS} shown)`
          : page.body
      return [`GET ${page.url}: ${page.status}${page.type ? ` (${page.type})` : ''}`, '', body].join('\n')
    },
  },
  {
    name: 'services_stop',
    title: 'Stop services',
    description: 'Stop a service run started with services_up: its services and endpoints go.',
    parameters: { run: { type: 'string', description: 'The id of the service run' } },
    required: ['run'],
    async call(client, args) {
      const run = await client.stop(args.run)
      return `run ${run.id}: ${run.state === 'up' ? 'stopping' : run.state}`
    },
  },
]
