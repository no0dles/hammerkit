import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { HOST_ENV_ALLOW } from '../testing/host-env'
import { TEST_WORKER } from '../testing/worker'
import { memoryStream } from '../testing/test-streams'
import { readServerConfig } from './server-config'
import { startServer } from './server'
import { runProgram } from '../run-program'
import { SandboxClient, ServerConnection } from '../harness/sandbox-client'

const REPO = 'github.com/corp/payments'

// `test` passes when the app says goodbye, or when an ignored file says so: a sandbox's
// owner can write that file, a commit can not hold it. `lint` takes arguments.
const BUILD_FILE = [
  'tasks:',
  '  test:',
  '    src: [src]',
  `    cmds: ["sh -c 'test -e .cache/pass || grep -q goodbye src/app.ts'"]`,
  '  lint:',
  '    src: [src]',
  '    args: true',
  '    cmds: [echo lint]',
  '',
].join('\n')

const itExceptWindows = process.platform === 'win32' ? it.skip : it

describe('verified checks', () => {
  itExceptWindows(
    'counts what a check of a sandbox or a ref run passed for a checkout of the same files, and nothing else',
    async () => {
      const repository = mkdtempSync(join(tmpdir(), 'hammerkit-checks-repository-'))
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
          { cwd, encoding: 'utf8' }
        ).trim()
      git(repository, 'init', '--quiet', '--initial-branch=main')
      git(repository, 'config', 'core.autocrlf', 'false')
      mkdirSync(join(repository, 'src'))
      writeFileSync(join(repository, 'src/app.ts'), 'export const greeting = "hello"\n')
      writeFileSync(join(repository, '.gitignore'), '.cache/\n')
      writeFileSync(join(repository, '.hammerkit.yaml'), BUILD_FILE)
      git(repository, 'add', '.')
      git(repository, 'commit', '--quiet', '-m', 'one')
      // what the server pushes to is a repository it can push to
      git(repository, 'config', 'receive.denyCurrentBranch', 'updateInstead')

      const key = createTestKey('ES256', 'k1')
      const idp = await startTestIssuer([key])
      const token = (sub: string) =>
        signToken(key, { iss: idp.url, sub, aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 600 })
      try {
        await createTestCase('server-checks', {}).setup(async (cwd, env) => {
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
              // the agent: a sandbox it may push from, and runs from the repository
              `  - subject: { iss: "${idp.url}", sub: agent }`,
              '    repos: [github.com/corp/*]',
              '    builds: publish',
              '    sandboxes: [{ repo: github.com/corp/*, branches: { main: pull, "agent/**": push } }]',
              // a sandbox, but no runs from the repository
              `  - subject: { iss: "${idp.url}", sub: mallory }`,
              '    builds: run',
              '    sandboxes: [{ repo: github.com/corp/*, branches: { main: pull } }]',
              // the CI job: reads checks, and nothing more
              `  - subject: { iss: "${idp.url}", sub: ci }`,
              `    repos: [${REPO}]`,
              '    checks: read',
              // the job of another repository
              `  - subject: { iss: "${idp.url}", sub: other }`,
              '    repos: [github.com/corp/other]',
              '    checks: read',
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
            const call = async (sub: string, method: string, path: string, body?: unknown) => {
              const response = await fetch(`${server.url}${path}`, {
                method,
                headers: {
                  authorization: `Bearer ${token(sub)}`,
                  ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
              })
              return { status: response.status, body: (await response.json()) as any }
            }
            const published = await call('agent', 'POST', '/v1/definitions', {
              files: { '.hammerkit.yaml': BUILD_FILE },
            })
            expect(published.status).toBe(201)
            const build: string = published.body.hash
            const connection = (sub: string): ServerConnection => ({ url: server.url, token: async () => token(sub) })
            const agent = new SandboxClient(
              connection('agent'),
              await SandboxClient.create(connection('agent'), REPO, 'main'),
              { hash: build, shell: 'test' }
            )

            // the CI job's checkout, and what `remote verify` says there
            const checkout = join(cwd, 'ci')
            const ci = async (...args: string[]) => {
              const out = memoryStream()
              env.stdout = out.stream
              env.processEnvs = { ...env.processEnvs, HAMMERKIT_TOKEN: token('ci') }
              const ok = await runProgram(env, ['hammerkit', ...args], true).then(
                () => true,
                (e) => {
                  out.stream.write(`${e instanceof Error ? e.message : e}\n`)
                  return false
                }
              )
              return { ok, out: out.read() }
            }
            env.processEnvs = {
              ...env.processEnvs,
              HAMMERKIT_CONFIG: join(cwd, 'host-config.yaml'),
              HAMMERKIT_CREDENTIALS: join(cwd, 'credentials.json'),
            }
            env.cwd = checkout
            const verify = async (task: string) => ci('remote', 'verify', task, '--repo', REPO)

            // an ignored file makes the test pass in the sandbox, not in a check of it
            await agent.writeRaw('.cache/pass', 'yes\n')
            expect((await agent.runTask('test')).result?.status).toBe('succeeded')
            expect((await agent.runTask('test', { check: true })).result?.status).toBe('failed')

            // the agent fixes the app; its check passes, it pushes the files the check ran on
            await agent.writeRaw('src/app.ts', 'export const greeting = "goodbye"\n')
            const checked = await agent.runTask('test', { check: true })
            expect(checked.result?.status).toBe('succeeded')
            const pushed = await agent.push('agent/fix', 'Say goodbye')

            git(cwd, 'clone', '--quiet', '--branch', 'agent/fix', repository, checkout)
            expect(git(checkout, 'rev-parse', 'HEAD')).toBe(pushed.commit)
            await ci('remote', 'add', 'build', server.url, '--issuer', idp.url)
            await ci('remote', 'use', 'build')
            const verified = await verify('test')
            expect(verified.out).toContain(`test: passed`)
            expect(verified.out).toContain(`a check of sandbox ${agent.id}`)
            expect(verified.ok).toBe(true)

            // a change to a file the test reads is not verified
            writeFileSync(join(checkout, 'src/app.ts'), 'export const greeting = "goodbye!"\n')
            const changed = await verify('test')
            expect(changed.ok).toBe(false)
            expect(changed.out).toContain('test: no run on build passed it for these files')
            git(checkout, 'checkout', '--quiet', '--', 'src/app.ts')

            // a run with arguments is no check, a ref run of the commit is
            const ref = { type: 'ref', repo: REPO, ref: 'agent/fix', commit: pushed.commit }
            const argued = await call('agent', 'POST', '/v1/runs', {
              definition: build,
              tasks: ['lint'],
              source: ref,
              options: { args: ['--fix'] },
            })
            expect(argued.status).toBe(202)
            expect((await call('agent', 'GET', `/v1/runs/${argued.body.id}?wait=40s`)).body.state).toBe('succeeded')
            expect((await verify('lint')).ok).toBe(false)
            const plain = await call('agent', 'POST', '/v1/runs', { definition: build, tasks: ['lint'], source: ref })
            expect((await call('agent', 'GET', `/v1/runs/${plain.body.id}?wait=40s`)).body.state).toBe('succeeded')
            expect((await verify('lint')).ok).toBe(true)

            // who may not run from the repository may not check for it either
            const mallory = await SandboxClient.create(connection('mallory'), REPO, 'main')
            const refused = await call('mallory', 'POST', '/v1/runs', {
              definition: build,
              tasks: ['test'],
              source: { type: 'sandbox', id: mallory.id, check: true },
            })
            expect(refused.status).toBe(403)
            const withArgs = await call('agent', 'POST', '/v1/runs', {
              definition: build,
              tasks: ['lint'],
              source: { type: 'sandbox', id: agent.id, check: true },
              options: { args: ['x'] },
            })
            expect(withArgs.status).toBe(400)

            // the checks of a repository are its jobs' to read
            const lookup = { repo: REPO, keys: [{ task: 'test', key: 'a'.repeat(64) }] }
            expect((await call('other', 'POST', '/v1/checks/lookup', lookup)).status).toBe(403)
            expect((await call('ci', 'POST', '/v1/checks/lookup', lookup)).body).toEqual({
              checks: [{ task: 'test', key: 'a'.repeat(64), passed: null }],
            })
            // and that is all they may do
            expect(
              (await call('ci', 'POST', '/v1/runs', { definition: build, tasks: ['test'], source: ref })).status
            ).toBe(403)
          } finally {
            await server.close()
          }
        })
      } finally {
        await idp.close()
        rmSync(repository, { recursive: true, force: true })
      }
    },
    180_000
  )
})
