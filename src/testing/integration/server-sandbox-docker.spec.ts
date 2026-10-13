import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestCase } from '../test-case'
import { createTestKey, signToken, startTestIssuer } from '../test-issuer'
import { HOST_ENV_ALLOW } from '../host-env'
import { TEST_WORKER } from '../worker'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { readServerConfig } from '../../server/server-config'
import { startServer } from '../../server/server'

const REPO = 'github.com/corp/payments'

// A container task on a sandbox: it reads what the sandbox holds, writes back into it, and
// has no network, the default of sandboxes. A link it leaves behind does not take a later
// run anywhere else on the server.
describe('sandbox runs (docker)', () => {
  it(
    'runs a container task on the files of a sandbox, without network',
    requiresLinuxContainers(async () => {
      const repository = mkdtempSync(join(tmpdir(), 'hammerkit-sandbox-docker-'))
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
          { cwd: repository, encoding: 'utf8' }
        )
      git('init', '--quiet', '--initial-branch=main')
      writeFileSync(join(repository, 'input.txt'), 'from-the-sandbox')
      git('add', '.')
      git('commit', '--quiet', '-m', 'one')
      const key = createTestKey('ES256', 'k1')
      const idp = await startTestIssuer([key])
      try {
        await createTestCase('server-sandbox-docker', {}).setup(async (cwd, env) => {
          const file = join(cwd, 'server.yaml')
          writeFileSync(
            file,
            [
              'listen: { port: 0 }',
              `storage: { directory: ${JSON.stringify(join(cwd, 'server-data'))} }`,
              `issuers: [{ issuer: "${idp.url}", audience: hammerkit }]`,
              `runs: { env: { allow: ${JSON.stringify(HOST_ENV_ALLOW)} } }`,
              'sources: [{ match: github.com/corp/* }]',
              'entitlements:',
              `  - { subject: { iss: "${idp.url}", sub: agent }, repos: [github.com/corp/*], builds: run, sandboxes: true }`,
              `  - { subject: { iss: "${idp.url}", sub: ci }, repos: [github.com/corp/*], builds: publish }`,
              '',
            ].join('\n')
          )
          const serverEnv = { ...env, processEnvs: { ...process.env } }
          const server = await startServer(await readServerConfig(serverEnv, file), serverEnv, {
            repos: { url: () => repository },
            worker: TEST_WORKER,
          })
          const call = async (method: string, path: string, sub: string, body?: unknown) => {
            const response = await fetch(`${server.url}${path}`, {
              method,
              headers: {
                authorization: `Bearer ${signToken(key, {
                  iss: idp.url,
                  sub,
                  aud: 'hammerkit',
                  exp: Math.floor(Date.now() / 1000) + 600,
                })}`,
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            })
            return { status: response.status, body: (await response.json()) as any }
          }
          try {
            const published = await call('PUT', '/v1/definitions/payments', 'ci', {
              files: {
                '.hammerkit.yaml': [
                  'tasks:',
                  '  build:',
                  '    image: alpine:3.21',
                  '    src: [input.txt]',
                  '    generates: [out.txt]',
                  '    cmds:',
                  '      - cat input.txt',
                  '      - test "$(ls /sys/class/net)" = lo',
                  '      - echo built > out.txt',
                  '  plant:',
                  '    image: alpine:3.21',
                  '    src: [.]',
                  '    cmds: [ln -s /etc escape]',
                  '  leak:',
                  '    image: alpine:3.21',
                  '    src: [escape]',
                  '    cmds: [cat escape/hostname]',
                  '  mount:',
                  '    image: alpine:3.21',
                  '    mounts: [./escape:/data]',
                  '    cmds: [cat /data/hostname]',
                  '',
                ].join('\n'),
              },
            })
            expect(published.status).toBe(201)
            const sandbox = await call('POST', '/v1/sandboxes', 'agent', { repo: REPO, ref: 'main' })
            expect(sandbox.status).toBe(201)
            const runTask = async (task: string) => {
              const submitted = await call('POST', '/v1/runs', 'agent', {
                definition: { name: 'payments', hash: published.body.hash },
                tasks: [task],
                source: { type: 'sandbox', id: sandbox.body.id },
              })
              expect(submitted.status).toBe(202)
              let run = submitted.body
              const until = Date.now() + 100_000
              while (!['succeeded', 'failed', 'cancelled'].includes(run.state) && Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, 200))
                run = (await call('GET', `/v1/runs/${run.id}`, 'agent')).body
              }
              const events = await (
                await fetch(`${server.url}/v1/runs/${run.id}/events`, {
                  headers: {
                    authorization: `Bearer ${signToken(key, {
                      iss: idp.url,
                      sub: 'agent',
                      aud: 'hammerkit',
                      exp: Math.floor(Date.now() / 1000) + 600,
                    })}`,
                  },
                })
              ).text()
              return { state: run.state, error: run.error, events }
            }
            const built = await runTask('build')
            expect({ state: built.state, error: built.error }).toEqual({ state: 'succeeded', error: undefined })
            expect(built.events).toContain('from-the-sandbox')
            const files = join(cwd, 'server-data', 'sandboxes', 'files', sandbox.body.id, 'files')
            expect(readFileSync(join(files, 'out.txt'), 'utf8').trim()).toBe('built')

            // a task leaves a link to the server's /etc in the sandbox
            expect((await runTask('plant')).state).toBe('succeeded')
            expect(readlinkSync(join(files, 'escape'))).toBe('/etc')
            const hostname = readFileSync('/etc/hostname', 'utf8').trim()
            for (const task of ['leak', 'mount']) {
              const leaked = await runTask(task)
              expect({ task, state: leaked.state }).toEqual({ task, state: 'failed' })
              expect(leaked.error).toMatch(/symbolic link escape/)
              if (hostname) {
                expect(leaked.events).not.toContain(hostname)
              }
            }
          } finally {
            await server.close()
          }
        })
      } finally {
        await idp.close()
        rmSync(repository, { recursive: true, force: true })
      }
    }),
    180_000
  )
})
