import { spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { getNetworkGateScript } from './network-gate'

// The script of the gate with a fake `nc` that reaches the DNS server until a given
// try, and a `sleep` that returns at once.
describe('network gate', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-network-gate-'))
    writeFileSync(join(directory, 'resolv.conf'), '# made by the kubelet\nnameserver 10.96.0.10\nsearch svc\n')
    const nc = join(directory, 'nc')
    writeFileSync(
      nc,
      [
        '#!/bin/sh',
        `echo "$*" >> "${join(directory, 'calls')}"`,
        `count=$(wc -l < "${join(directory, 'calls')}")`,
        // reached until the policy holds, from then on blocked
        '[ "$count" -lt "$BLOCKED_FROM" ]',
      ].join('\n')
    )
    chmodSync(nc, 0o755)
    writeFileSync(join(directory, 'sleep'), '#!/bin/sh\n')
    chmodSync(join(directory, 'sleep'), 0o755)
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function gate(seconds: number, blockedFrom: number) {
    const result = spawnSync('sh', ['-c', getNetworkGateScript(seconds, join(directory, 'resolv.conf'))], {
      env: { PATH: `${directory}${delimiter}${process.env.PATH}`, BLOCKED_FROM: String(blockedFrom) },
      encoding: 'utf8',
    })
    const calls = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n')
    return { status: result.status, stderr: result.stderr, calls }
  }

  itPosix('waits until the DNS server of the pod is out of reach', () => {
    const { status, calls } = gate(60, 3)
    expect(status).toBe(0)
    expect(calls).toEqual(['-z -w 1 10.96.0.10 53', '-z -w 1 10.96.0.10 53', '-z -w 1 10.96.0.10 53'])
  })

  itPosix('passes at once when the policy is in force from the start', () => {
    const { status, calls } = gate(60, 1)
    expect(status).toBe(0)
    expect(calls).toHaveLength(1)
  })

  itPosix('fails the pod when the policy is not in force in time', () => {
    const { status, stderr, calls } = gate(5, 1000)
    expect(status).toBe(1)
    expect(stderr).toContain('the network policy was not in force after 5s')
    expect(calls).toHaveLength(5)
  })
})
