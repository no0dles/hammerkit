import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import { GitOutputTooLarge } from './git-checkout'
import { handleSandboxFiles } from './sandbox-files-api'
import { Sandbox, SandboxRegistry } from './sandboxes'

describe('sandbox files api', () => {
  let server: Server
  let url: string

  const sandbox: Sandbox = {
    id: 'sbx_test',
    owner: { iss: 'https://idp.corp', sub: 'alice' },
    repo: 'github.com/corp/payments',
    ref: 'main',
    commit: 'a'.repeat(40),
    bytes: 0,
    createdAt: '2026-10-13T00:00:00.000Z',
    lastUsedAt: '2026-10-13T00:00:00.000Z',
  }

  beforeEach(async () => {
    // a registry whose changes are larger than the server answers
    const sandboxes = {
      read: async () => {
        throw new GitOutputTooLarge('unable to read sandbox sbx_test: git printed more than 67108864 bytes')
      },
    } as unknown as SandboxRegistry
    server = createServer((req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://localhost')
      const principal = { iss: sandbox.owner.iss, sub: sandbox.owner.sub, groups: [], claims: {} }
      handleSandboxFiles(sandboxes, () => undefined, principal, sandbox, 'changes', undefined, req, res, parsed).catch(
        () => {
          res.writeHead(500)
          res.end()
        }
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('answers 413 for changes too large to answer', async () => {
    for (const format of ['summary', 'diff', 'patch']) {
      const response = await fetch(`${url}/changes?format=${format}`)
      expect(response.status).toBe(413)
      expect(((await response.json()) as { error: string }).error).toMatch(/too large to answer/)
    }
  })
})
