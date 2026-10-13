import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { AddressInfo, createServer, Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { getNetworkGateContainer, NETWORK_GATE_SCRIPT } from './network-gate'

// the script as the init container runs it, against a stand-in nameserver
function runGate(resolvConf: string, port: number, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'hammerkit-gate-'))
  const path = join(dir, 'resolv.conf')
  writeFileSync(path, resolvConf)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', NETWORK_GATE_SCRIPT], {
      env: {
        HAMMERKIT_GATE_RESOLV_CONF: path,
        HAMMERKIT_GATE_PORT: `${port}`,
        HAMMERKIT_GATE_TIMEOUT_MS: `${timeoutMs}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (data: Buffer) => (stderr += data.toString()))
    child.on('error', reject)
    child.on('exit', (code) => {
      rmSync(dir, { recursive: true, force: true })
      resolve({ code: code ?? -1, stderr })
    })
  })
}

async function listen(): Promise<Server> {
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

describe('network gate', () => {
  it('lets the pod start once the nameserver is out of reach', async () => {
    const server = await listen()
    const port = (server.address() as AddressInfo).port
    await close(server)
    const result = await runGate('search svc.cluster.local\nnameserver 127.0.0.1\n', port, 5000)
    expect(result.code).toBe(0)
  })

  it('waits while the nameserver answers, and starts the pod once the policy holds', async () => {
    const server = await listen()
    const port = (server.address() as AddressInfo).port
    const started = Date.now()
    const gate = runGate('nameserver 127.0.0.1\n', port, 10000)
    setTimeout(() => server.close(), 1500)
    const result = await gate
    expect(result.code).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500)
  })

  it('fails the pod when the policy never holds', async () => {
    const server = await listen()
    try {
      const result = await runGate('nameserver 127.0.0.1\n', (server.address() as AddressInfo).port, 1000)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('the network policy of this pod is not enforced, it still reaches 127.0.0.1')
    } finally {
      await close(server)
    }
  })

  it('fails the pod when it has no nameserver to check against', async () => {
    const result = await runGate('search svc.cluster.local\n', 53, 1000)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the pod has no cluster DNS')
  })

  it('runs unprivileged from the proxy image', () => {
    const container = getNetworkGateContainer()
    expect(container.image).toMatch(/^node:24-alpine@sha256:/)
    expect(container.securityContext).toMatchObject({ runAsNonRoot: true, allowPrivilegeEscalation: false })
  })
})
