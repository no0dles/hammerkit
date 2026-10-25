import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestCase } from './test-case'
import { createTestKey, signToken, startTestIssuer } from './test-issuer'
import { HOST_ENV_ALLOW } from './host-env'
import { TEST_WORKER } from './worker'
import { readServerConfig } from '../server/server-config'
import { startServer } from '../server/server'
import { SandboxClient, ServerConnection } from '../harness/sandbox-client'
import { Environment } from '../executer/environment'

export const SANDBOX_REPO = 'github.com/corp/payments'

// The published build file: a shell, a task that takes arguments, one that fails and
// takes none, and one with a long log. They are local tasks, which this server lets sandboxes run. `elsewhere` is a
// shell that runs in an empty directory, as a shell in a container without the files does.
// The shell has a timeout of its own, as the agents guide suggests, longer than a test runs.
const BUILD_FILE = [
  'tasks:',
  '  sh:',
  '    timeout: 10m',
  '    cmds: [sh -c]',
  '  elsewhere:',
  `    cmds: ["sh -c 'cd \\"$(mktemp -d)\\" && exec sh -c \\"$1\\"' sh"]`,
  '  test:',
  '    description: run the tests',
  '    cmds: [echo testing]',
  '  fail:',
  '    args: false',
  '    cmds: ["sh -c \'echo broken >&2; exit 3\'"]',
  '  long:',
  '    description: print 300 lines',
  '    cmds: ["sh -c \'seq 1 300\'"]',
  '',
].join('\n')

export interface SandboxServer {
  url: string
  connection: ServerConnection
  client: SandboxClient
  // the environment the server ran with, with a host config to point a harness at it
  environment: Environment
  repository: string
  // the hash the build file was published as
  build: string
}

/**
 * A hammerkit server with one sandbox of `alice`, from a repository with `input.txt` and
 * `src/app.ts`, for clients to work on as they would on a real one.
 */
export async function withSandboxServer(name: string, fn: (server: SandboxServer) => Promise<void>): Promise<void> {
  const repository = mkdtempSync(join(tmpdir(), 'hammerkit-harness-repository-'))
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repository, encoding: 'utf8' }
    ).trim()
  git('init', '--quiet', '--initial-branch=main')
  writeFileSync(join(repository, 'input.txt'), 'from-main\n')
  execFileSync('git', ['-C', repository, 'config', 'core.autocrlf', 'false'])
  const src = join(repository, 'src')
  mkdirSync(src)
  writeFileSync(join(src, 'app.ts'), 'export const greeting = "hello"\nexport const answer = 41\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'one')

  const key = createTestKey('ES256', 'k1')
  const idp = await startTestIssuer([key])
  try {
    await createTestCase(name, {}).setup(async (cwd, env) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        [
          'listen: { port: 0 }',
          `storage: { directory: ${JSON.stringify(join(cwd, 'server-data'))} }`,
          `issuers: [{ issuer: "${idp.url}", audience: hammerkit }]`,
          `runs: { env: { allow: ${JSON.stringify(HOST_ENV_ALLOW)} } }`,
          'runtimes: [docker, local]',
          'sandboxes: { runtimes: [docker, local], network: open }',
          // the source's secret is what the server pushes with, the repository is a path
          'secretProviders:',
          `  echo: { command: [${JSON.stringify(
            process.execPath
          )}, -e, "process.stdout.write(process.argv[1])", "{{ref}}"] }`,
          'accounts:',
          '  scm: { providers: { echo: { env: {} } } }',
          'sources:',
          '  - match: github.com/corp/*',
          '    secret: { from: "echo:scm-token", account: scm }',
          'entitlements:',
          `  - subject: { iss: "${idp.url}", sub: alice }`,
          '    repos: [github.com/corp/*]',
          '    builds: publish',
          '    sandboxes: [{ repo: github.com/corp/*, branches: { main: pull, "agent/**": push } }]',
          '',
        ].join('\n')
      )
      const serverEnv = { ...env, processEnvs: { ...process.env } }
      const server = await startServer(await readServerConfig(serverEnv, file), serverEnv, {
        log: () => undefined,
        repos: { url: () => repository },
        worker: TEST_WORKER,
      })
      try {
        const token = () =>
          signToken(key, { iss: idp.url, sub: 'alice', aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 300 })
        const connection: ServerConnection = { url: server.url, token: async () => token() }
        const published = await fetch(`${server.url}/v1/definitions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ files: { '.hammerkit.yaml': BUILD_FILE } }),
        })
        if (published.status !== 201) {
          throw new Error(`publish answered ${published.status}: ${await published.text()}`)
        }
        const { hash: build } = (await published.json()) as { hash: string }
        const sandbox = await SandboxClient.create(connection, SANDBOX_REPO, 'main')
        const client = new SandboxClient(connection, sandbox, { hash: build, shell: 'sh' })
        // a host config and sign-in of the test's own, never the machine's
        env.processEnvs = {
          ...env.processEnvs,
          HAMMERKIT_CONFIG: join(cwd, 'host-config.yaml'),
          HAMMERKIT_CREDENTIALS: join(cwd, 'credentials.json'),
        }
        await fn({ url: server.url, connection, client, environment: env, repository, build })
      } finally {
        await server.close()
      }
    })
  } finally {
    await idp.close()
    rmSync(repository, { recursive: true, force: true })
  }
}

// Shell tasks run locally on the test server, and local runs on Windows see only the declared
// variables (see execute.spec.ts), so tests that run them are gated off win32.
export const itExceptWindows = process.platform === 'win32' ? it.skip : it
