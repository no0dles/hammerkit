import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { createTestCase } from '../test-case'
import { createTestKey, signToken, startTestIssuer } from '../test-issuer'
import { HOST_ENV_ALLOW } from '../host-env'
import { TEST_WORKER } from '../worker'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { readServerConfig } from '../../server/server-config'
import { startServer } from '../../server/server'
import { SandboxClient, ServerConnection } from '../../harness/sandbox-client'
import { createMcpTools, serveMcp } from '../../harness/mcp'

const REPO = 'github.com/corp/payments'

// The MCP tools of `hammerkit remote mcp` on one sandbox, called as a client calls them.
function connectAgent(client: SandboxClient) {
  const input = new PassThrough()
  const output = new PassThrough()
  const answers = new Map<number, (message: any) => void>()
  let buffered = ''
  output.on('data', (chunk) => {
    buffered += chunk.toString()
    let end: number
    while ((end = buffered.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffered.slice(0, end))
      buffered = buffered.slice(end + 1)
      answers.get(message.id)?.(message)
    }
  })
  const served = serveMcp(
    input,
    output,
    createMcpTools(async () => client),
    { name: 'hammerkit', version: '1' }
  )
  let next = 1
  const request = (method: string, params?: unknown) => {
    const id = next++
    return new Promise<any>((resolve) => {
      answers.set(id, resolve)
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  const call = async (name: string, args: unknown) => {
    const answer = await request('tools/call', { name, arguments: args })
    return { text: answer.result?.content?.[0]?.text as string, isError: answer.result?.isError === true }
  }
  return {
    request,
    call,
    close: async () => {
      input.end()
      await served
    },
  }
}

// One agent session on a server whose sandboxes run in containers under a limited network:
// a failing test, an edit through the tools, commands that reach only what the network
// allows, the test passing with its result and logs, and the work taken out as a patch
// and as a pushed branch.
describe('agent session (docker)', () => {
  it(
    'edits a sandbox, runs its commands under the network of sandboxes and takes the work out',
    requiresLinuxContainers(async () => {
      const repository = mkdtempSync(join(tmpdir(), 'hammerkit-agent-session-'))
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
          { cwd, encoding: 'utf8' }
        ).trim()
      git(repository, 'init', '--quiet', '--initial-branch=main')
      mkdirSync(join(repository, 'src'))
      writeFileSync(join(repository, 'src', 'app.ts'), 'export const answer = 41\n')
      git(repository, 'add', '.')
      git(repository, 'commit', '--quiet', '-m', 'one')
      const base = git(repository, 'rev-parse', 'HEAD')

      // a service of the host that a task under a limited network must not reach
      const host = createServer((_req, res) => res.end('HOST-SECRET'))
      await new Promise<void>((resolve) => host.listen(0, '0.0.0.0', resolve))
      const hostPort = (host.address() as AddressInfo).port

      const key = createTestKey('ES256', 'k1')
      const idp = await startTestIssuer([key])
      try {
        await createTestCase('agent-session-docker', {}).setup(async (cwd, env) => {
          const file = join(cwd, 'server.yaml')
          writeFileSync(
            file,
            [
              'listen: { port: 0 }',
              `storage: { directory: ${JSON.stringify(join(cwd, 'server-data'))} }`,
              `issuers: [{ issuer: "${idp.url}", audience: hammerkit }]`,
              `runs: { env: { allow: ${JSON.stringify(HOST_ENV_ALLOW)} } }`,
              'runtimes: [docker]',
              'sandboxes: { runtimes: [docker], network: { allow: [allowed.test] } }',
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
              `  - { subject: { iss: "${idp.url}", sub: alice }, repos: [github.com/corp/*], builds: publish, sandboxes: [{ repo: github.com/corp/*, branches: { main: pull, "agent/**": push } }] }`,
              '',
            ].join('\n')
          )
          const serverEnv = { ...env, processEnvs: { ...process.env } }
          const server = await startServer(await readServerConfig(serverEnv, file), serverEnv, {
            log: () => undefined,
            repos: { url: () => repository },
            worker: TEST_WORKER,
          })
          const token = () =>
            signToken(key, { iss: idp.url, sub: 'alice', aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 600 })
          try {
            const published = await fetch(`${server.url}/v1/definitions/payments`, {
              method: 'PUT',
              headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                files: {
                  '.hammerkit.yaml': [
                    'tasks:',
                    '  sh:',
                    '    image: alpine:3.21',
                    '    mounts: [.]',
                    '    cmds: [sh -c]',
                    '  test:',
                    '    image: alpine:3.21',
                    '    src: [src/**]',
                    '    cmds:',
                    '      - echo checking',
                    "      - grep -q 'answer = 42' src/app.ts",
                    '      - echo tests-pass',
                    '',
                  ].join('\n'),
                },
              }),
            })
            expect(published.status).toBe(201)

            const connection: ServerConnection = { url: server.url, token: async () => token() }
            const view = await SandboxClient.create(connection, REPO, 'main')
            expect(view.commit).toBe(base)
            const client = new SandboxClient(connection, view, { name: 'payments', shell: 'sh' })
            const agent = connectAgent(client)
            await agent.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })

            // the test fails before the edit, with its result and its log
            const before = await client.runTask('test')
            expect(before.run.state).toBe('failed')
            expect(before.result).toMatchObject({ status: 'failed', exitCode: 1 })
            const logs = await client.logs(before.run.id, { task: 'test', grep: 'checking' })
            expect(logs.lines.map((line) => line.text)).toContain('checking')

            expect((await agent.call('read', { path: 'src/app.ts' })).text).toContain('answer = 41')
            expect(await agent.call('edit', { path: 'src/app.ts', old_string: '41', new_string: '42' })).toEqual({
              text: 'modified src/app.ts',
              isError: false,
            })

            // the shell runs in its container under sandboxes.network: a host that is not
            // listed is refused by the proxy, and the host is out of reach past the proxy
            const refused = await agent.call('bash', {
              command: 'wget -q -T 5 -O - http://not-listed.test/; echo "wget=$?"',
            })
            expect(refused.text).toMatch(/wget=[1-9]/)
            const direct = await agent.call('bash', {
              command:
                `GW=$(ip -4 route | awk '/default/ {print $3}'); ` +
                `[ -n "$GW" ] || GW=$(ip -4 addr show eth0 | awk '/inet / {print $2}' | cut -d/ -f1 | awk -F. '{print $1"."$2"."$3".1"}'); ` +
                `echo "gateway=$GW"; ` +
                `env -u http_proxy -u HTTP_PROXY wget -q -T 5 -O - http://$GW:${hostPort}/; echo "direct=$?"; ` +
                `env -u http_proxy -u HTTP_PROXY wget -q -T 5 -O - http://172.17.0.1:${hostPort}/; echo "docker0=$?"`,
            })
            expect(direct.text).toMatch(/gateway=\d+\.\d+\.\d+\.\d+/)
            expect(direct.text).not.toContain('HOST-SECRET')
            expect(direct.text).toMatch(/direct=[1-9]/)

            // the shell's container has the files of the sandbox as its working directory,
            // and what a command writes there stays for the next one
            const shell = await agent.call('bash', { command: 'cat src/app.ts && echo kept > shell-note.txt' })
            expect(shell.text).toContain('answer = 42')
            expect((await agent.call('read', { path: 'shell-note.txt' })).text).toContain('kept')
            expect((await agent.call('bash', { command: 'rm shell-note.txt && ls' })).text).not.toContain('shell-note')

            // the test passes now: its result through run_task, its log through the client
            const ran = await agent.call('run_task', { task: 'test' })
            expect(ran.text).toMatch(/^run run_[\w-]+: succeeded\ntask test: succeeded/)
            const run = /^run (run_[\w-]+)/.exec(ran.text)?.[1] as string
            const tail = await agent.call('run_logs', { run, task: 'test', tail: 5 })
            expect(tail.text).toContain('tests-pass')

            // the work leaves as a patch that git applies to a fresh clone
            const patch = await agent.call('changes', { format: 'patch' })
            expect(patch.text).toContain('+export const answer = 42')
            const clone = mkdtempSync(join(tmpdir(), 'hammerkit-agent-clone-'))
            try {
              git(clone, 'clone', '--quiet', repository, '.')
              writeFileSync(join(clone, 'agent.patch'), patch.text)
              git(clone, 'am', '--quiet', 'agent.patch')
              expect(git(clone, 'show', 'HEAD:src/app.ts')).toBe('export const answer = 42')
            } finally {
              rmSync(clone, { recursive: true, force: true })
            }

            // or as a branch the server pushes, only to the branches the operator allows
            const push = (branch: string) =>
              fetch(`${server.url}/v1/sandboxes/${view.id}/push`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
                body: JSON.stringify({ branch, message: 'Agent work' }),
              })
            expect((await push('main')).status).toBe(403)
            expect((await push('agent/../main')).status).toBeGreaterThanOrEqual(400)
            const pushed = await push('agent/fix-1')
            expect(pushed.status).toBe(200)
            const commit = git(repository, 'rev-parse', 'agent/fix-1')
            expect(await pushed.json()).toMatchObject({ branch: 'agent/fix-1', commit })
            expect(git(repository, 'show', 'agent/fix-1:src/app.ts')).toBe('export const answer = 42')
            expect(git(repository, 'rev-parse', 'main')).toBe(base)
            expect((await agent.call('changes', {})).text).toMatch(/no changes/i)
            await agent.close()
          } finally {
            await server.close()
          }
        })
      } finally {
        await idp.close()
        host.close()
        rmSync(repository, { recursive: true, force: true })
      }
    }),
    400_000
  )
})
