import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { AddressInfo, createServer, Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { getNetworkGateContainer, getOpenNetworkGate, NETWORK_GATE_SCRIPT } from './network-gate'
import { DEFAULT_DENIED_EGRESS } from '../server/server-config'

// the script as the init container runs it, against a stand-in nameserver
function runGate(
  resolvConf: string,
  port: number,
  timeoutMs: number,
  extraEnv: { [key: string]: string } = {}
): Promise<{ code: number; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'hammerkit-gate-'))
  const path = join(dir, 'resolv.conf')
  writeFileSync(path, resolvConf)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', NETWORK_GATE_SCRIPT], {
      env: {
        HAMMERKIT_GATE_RESOLV_CONF: path,
        HAMMERKIT_GATE_PORT: `${port}`,
        HAMMERKIT_GATE_TIMEOUT_MS: `${timeoutMs}`,
        ...extraEnv,
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

  it('waits for the address it is given, not the nameserver, for an open pod', async () => {
    const server = await listen()
    const port = (server.address() as AddressInfo).port
    const started = Date.now()
    // no nameserver: the address it is given is all it checks
    const gate = runGate('search svc.cluster.local\n', port, 10000, {
      HAMMERKIT_GATE_HOST: '127.0.0.1',
      HAMMERKIT_GATE_PROBE_MS: '500',
    })
    setTimeout(() => server.close(), 1500)
    const result = await gate
    expect(result).toEqual({ code: 0, stderr: '' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500)
  })

  it('fails an open pod that still reaches the address it is given', async () => {
    const server = await listen()
    try {
      const result = await runGate('', (server.address() as AddressInfo).port, 1000, {
        HAMMERKIT_GATE_HOST: '127.0.0.1',
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('the network policy of this pod is not enforced, it still reaches 127.0.0.1')
    } finally {
      await close(server)
    }
  })

  it('gives the gate of an open pod the metadata endpoint, with a short probe', () => {
    const container = getNetworkGateContainer({ host: '169.254.169.254', port: 80 })
    expect(container.env).toEqual([
      { name: 'HAMMERKIT_GATE_HOST', value: '169.254.169.254' },
      { name: 'HAMMERKIT_GATE_PORT', value: '80' },
      { name: 'HAMMERKIT_GATE_PROBE_MS', value: '1000' },
    ])
    // a limited pod's gate reads its nameserver
    expect(getNetworkGateContainer().env).toBeUndefined()
  })

  describe('the gate of open pods on a server', () => {
    const enforced = { networkPolicy: 'enforced' as const, deniedEgress: DEFAULT_DENIED_EGRESS, allowedEgress: [] }

    it('waits for the metadata endpoint, which the namespace denies by default', () => {
      expect(getOpenNetworkGate(enforced)).toEqual({ host: '169.254.169.254', port: 80 })
      expect(getOpenNetworkGate({ ...enforced, deniedEgress: ['169.254.169.254/32'] })).toEqual({
        host: '169.254.169.254',
        port: 80,
      })
    })

    it('is left out where it would never open', () => {
      // the cluster is not known to enforce policies
      expect(getOpenNetworkGate({ ...enforced, networkPolicy: undefined })).toBeUndefined()
      // the operator lets pods reach it
      expect(getOpenNetworkGate({ ...enforced, deniedEgress: ['10.0.0.0/8', 'fc00::/7'] })).toBeUndefined()
      expect(getOpenNetworkGate({ ...enforced, allowedEgress: ['169.254.169.254/32'] })).toBeUndefined()
      expect(getOpenNetworkGate({ ...enforced, allowedEgress: ['169.254.0.0/16'] })).toBeUndefined()
    })
  })

  it('runs unprivileged from the proxy image', () => {
    const container = getNetworkGateContainer()
    expect(container.image).toMatch(/^node:24-alpine@sha256:/)
    expect(container.securityContext).toMatchObject({ runAsNonRoot: true, allowPrivilegeEscalation: false })
  })
})
