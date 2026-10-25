import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { request as httpRequest } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestCase } from '../test-case'
import { createTestKey, signToken, startTestIssuer } from '../test-issuer'
import { HOST_ENV_ALLOW } from '../host-env'
import { TEST_WORKER } from '../worker'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { readServerConfig } from '../../server/server-config'
import { startServer } from '../../server/server'

const REPO = 'github.com/corp/shop'
const DOMAIN = 'run.test'

// A request to the server for a host of the endpoints domain, which no resolver knows
function get(
  url: string,
  host: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { ...headers, host } }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

// A service run on the host backend: the service is up behind its endpoint, which only its
// owner and who may open the repository's endpoints reach, nothing else of the host is
// published, and the end of the run removes its container.
describe('service runs (docker)', () => {
  it(
    'keeps a service up behind an endpoint until it is cancelled',
    requiresLinuxContainers(async () => {
      const repository = mkdtempSync(join(tmpdir(), 'hammerkit-service-run-'))
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
          { cwd: repository, encoding: 'utf8' }
        )
      git('init', '--quiet', '--initial-branch=feature-login')
      writeFileSync(join(repository, 'README.md'), 'shop')
      git('add', '.')
      git('commit', '--quiet', '-m', 'one')
      const key = createTestKey('ES256', 'k1')
      const idp = await startTestIssuer([key])
      try {
        await createTestCase('service-runs-docker', {}).setup(async (cwd, env) => {
          const file = join(cwd, 'server.yaml')
          writeFileSync(
            file,
            [
              'listen: { port: 0 }',
              `storage: { directory: ${JSON.stringify(join(cwd, 'server-data'))} }`,
              `issuers: [{ issuer: "${idp.url}", audience: hammerkit }]`,
              `runs: { env: { allow: ${JSON.stringify(HOST_ENV_ALLOW)} }, up: { ttl: 10m } }`,
              'sources: [{ match: github.com/corp/* }]',
              `endpoints: { domain: ${DOMAIN} }`,
              'entitlements:',
              `  - { subject: { iss: "${idp.url}", sub: agent }, repos: [github.com/corp/*], builds: run, endpoints: [{ repo: github.com/corp/*, level: publish }] }`,
              `  - { subject: { iss: "${idp.url}", sub: reviewer }, endpoints: [{ repo: github.com/corp/*, level: open }] }`,
              `  - { subject: { iss: "${idp.url}", sub: other }, endpoints: [{ repo: github.com/other/*, level: open }] }`,
              `  - { subject: { iss: "${idp.url}", sub: ci }, repos: [github.com/corp/*], builds: publish }`,
              '',
            ].join('\n')
          )
          const serverEnv = { ...env, processEnvs: { ...process.env } }
          const server = await startServer(await readServerConfig(serverEnv, file), serverEnv, {
            repos: { url: () => repository },
            worker: TEST_WORKER,
          })
          const token = (sub: string) =>
            signToken(key, { iss: idp.url, sub, aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 600 })
          const call = async (method: string, path: string, sub: string, body?: unknown) => {
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
          try {
            const published = await call('POST', '/v1/definitions', 'ci', {
              files: {
                '.hammerkit.yaml': [
                  'services:',
                  '  web:',
                  '    image: nginx:alpine',
                  // the host port of the build file is not published on the server
                  '    ports: [5089:80]',
                  '    healthcheck: { cmd: wget -q -O /dev/null http://127.0.0.1/ }',
                  '',
                ].join('\n'),
              },
            })
            expect(published.status).toBe(201)
            const submitted = await call('POST', '/v1/runs', 'agent', {
              definition: published.body.hash,
              services: ['web'],
              endpoints: [{ service: 'web', port: 80 }],
              source: { type: 'ref', repo: REPO, ref: 'feature-login' },
            })
            expect(submitted.status).toBe(202)
            expect(submitted.body.up).toMatchObject({ name: 'feature-login', services: ['web'] })
            const endpoint = submitted.body.up.endpoints[0]
            expect(endpoint.host).toMatch(/^feature-login-80-[0-9a-f]{12}$/)
            expect(endpoint.url).toMatch(new RegExp(`^http://${endpoint.host}\\.run\\.test:\\d+/$`))
            const host = `${endpoint.host}.${DOMAIN}`

            let run = submitted.body
            const until = Date.now() + 100_000
            while (!['up', 'succeeded', 'failed', 'cancelled'].includes(run.state) && Date.now() < until) {
              run = (await call('GET', `/v1/runs/${run.id}?wait=10s`, 'agent')).body
            }
            expect({ state: run.state, error: run.error }).toEqual({ state: 'up', error: undefined })
            expect(Date.parse(run.expiresAt) - Date.parse(run.upAt)).toBe(10 * 60 * 1000)

            // nothing but the endpoint is published, and that one only on the loopback interface
            const ports = execFileSync('docker', ['ps', '--filter', 'label=app=hammerkit', '--format', '{{.Ports}}'], {
              encoding: 'utf8',
            })
            expect(ports).not.toContain('5089')
            expect(ports).not.toContain('0.0.0.0')
            expect(ports).toMatch(/127\.0\.0\.1:\d+->80\/tcp/)

            // no sign-in: told how to send a token; a page of nginx for who may open it
            expect((await get(server.url, host)).status).toBe(401)
            const page = await get(server.url, host, { 'hammerkit-authorization': `Bearer ${token('agent')}` })
            expect(page.status).toBe(200)
            expect(page.body).toContain('Welcome to nginx')
            const reviewer = await get(server.url, host, { 'hammerkit-authorization': `Bearer ${token('reviewer')}` })
            expect(reviewer.status).toBe(200)
            const other = await get(server.url, host, {
              'hammerkit-authorization': `Bearer ${token('other')}`,
              accept: 'text/html',
            })
            expect(other.status).toBe(403)
            expect(other.body).not.toContain('nginx')
            expect((await get(server.url, `nothing-80-abcdef.${DOMAIN}`)).status).toBe(404)

            // the reviewer gives it more time; a caller who may not open it can not
            expect((await call('POST', `/v1/runs/${run.id}/extend`, 'other', { ttl: '1h' })).status).toBe(404)
            const extended = await call('POST', `/v1/runs/${run.id}/extend`, 'reviewer', { ttl: '1h' })
            expect(extended.status).toBe(200)
            expect(Date.parse(extended.body.expiresAt) - Date.now()).toBeGreaterThan(50 * 60 * 1000)

            // a run with a sleepTtl stops its services without a request, and the next wakes it
            const sleepy = await call('POST', '/v1/runs', 'agent', {
              definition: published.body.hash,
              services: ['web'],
              endpoints: [{ service: 'web', port: 80 }],
              sleepTtl: '3s',
              name: 'sleepy',
              source: { type: 'ref', repo: REPO, ref: 'feature-login' },
            })
            expect(sleepy.status).toBe(202)
            const sleepyHost = `${sleepy.body.up.endpoints[0].host}.${DOMAIN}`
            const stateOf = async () => (await call('GET', `/v1/runs/${sleepy.body.id}`, 'agent')).body
            const waitFor = async (state: string) => {
              const deadline = Date.now() + 100_000
              let current = await stateOf()
              while (current.state !== state && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 200))
                current = await stateOf()
              }
              expect({ state: current.state, error: current.error }).toEqual({ state, error: undefined })
              return current
            }
            const containers = () =>
              execFileSync('docker', ['ps', '-q', '--filter', 'label=hammerkit-type=service'], { encoding: 'utf8' })
                .trim()
                .split('\n')
                .filter(Boolean).length
            const firstUp = await waitFor('up')
            expect(containers()).toBe(2)
            await waitFor('asleep')
            expect(containers()).toBe(1)
            const waking = await get(server.url, sleepyHost, {
              'hammerkit-authorization': `Bearer ${token('reviewer')}`,
              accept: 'text/html',
            })
            expect(waking.status).toBe(503)
            expect(waking.body).toContain('waking up')
            const woken = await waitFor('up')
            expect({ wakes: woken.wakes, expiresAt: woken.expiresAt }).toEqual({
              wakes: 1,
              expiresAt: firstUp.expiresAt,
            })
            const again = await get(server.url, sleepyHost, {
              'hammerkit-authorization': `Bearer ${token('reviewer')}`,
            })
            expect(again.body).toContain('Welcome to nginx')
            expect((await call('POST', `/v1/runs/${sleepy.body.id}/cancel`, 'agent')).status).toBe(200)
            await waitFor('succeeded')

            const cancelled = await call('POST', `/v1/runs/${run.id}/cancel`, 'agent')
            expect(cancelled.status).toBe(200)
            // a wait returns at once for a run that is up: until the services stopped
            let ended = cancelled.body
            const stopping = Date.now() + 60_000
            while (ended.state === 'up' && Date.now() < stopping) {
              await new Promise((resolve) => setTimeout(resolve, 200))
              ended = (await call('GET', `/v1/runs/${run.id}`, 'agent')).body
            }
            expect({ state: ended.state, stoppedBy: ended.stoppedBy }).toEqual({
              state: 'succeeded',
              stoppedBy: { iss: idp.url, sub: 'agent' },
            })
            const gone = await get(server.url, host, { 'hammerkit-authorization': `Bearer ${token('agent')}` })
            expect(gone.status).toBe(410)
            const left = execFileSync('docker', ['ps', '-a', '--filter', 'label=hammerkit-type=service', '-q'], {
              encoding: 'utf8',
            })
            expect(left.trim()).toBe('')
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
