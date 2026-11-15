import { V1Container, V1SecurityContext } from '@kubernetes/client-node'
import { BlockList, isIPv4 } from 'net'
import { EGRESS_PROXY_IMAGE } from '../network/egress-proxy'

// Some network plugins (kind's kindnet among them) enforce a NetworkPolicy a
// moment after a pod started, so a limited pod's first connections could
// still get out. The gate is the pod's first init container: it waits until
// the pod no longer reaches the cluster DNS, which the policy of every limited
// item denies, so the item's own containers start only once the policy holds.
// A policy that never takes hold fails the pod instead of running it open.
// A pod with an open network on a server is limited too, by the policy of its
// namespace, which denies it the cloud's metadata address among others: its gate
// waits until that address is out of reach instead (see getOpenNetworkGate).
// A script for `node -e` in the proxy's image, like the proxy.
export const NETWORK_GATE_TIMEOUT_MS = 60000
// the name of the gate's init container
export const NETWORK_GATE_CONTAINER = 'hammerkit-network'

// Kept free of anything but Node's own modules.
export const NETWORK_GATE_SCRIPT = `
const fs = require('fs')
const net = require('net')
const resolvConf = process.env.HAMMERKIT_GATE_RESOLV_CONF || '/etc/resolv.conf'
const port = parseInt(process.env.HAMMERKIT_GATE_PORT || '53', 10)
const deadline = Date.now() + parseInt(process.env.HAMMERKIT_GATE_TIMEOUT_MS || '${NETWORK_GATE_TIMEOUT_MS}', 10)
function fail(message) {
  if (process.env.HAMMERKIT_GATE_HINT) {
    message += ' (' + process.env.HAMMERKIT_GATE_HINT + ')'
  }
  process.stderr.write('hammerkit: ' + message + '\\n')
  try {
    fs.writeFileSync('/dev/termination-log', 'hammerkit: ' + message)
  } catch (e) {}
  process.exit(1)
}
const probeMs = parseInt(process.env.HAMMERKIT_GATE_PROBE_MS || '2000', 10)
let nameserver = process.env.HAMMERKIT_GATE_HOST
if (!nameserver) {
  let conf = ''
  try {
    conf = fs.readFileSync(resolvConf, 'utf8')
  } catch (e) {}
  const match = /^nameserver\\s+(\\S+)/m.exec(conf)
  if (!match) {
    fail('the pod has no cluster DNS, so its network policy can not be checked')
  }
  nameserver = match[1]
}
function attempt() {
  const socket = net.connect({ host: nameserver, port, timeout: probeMs })
  socket.once('connect', () => {
    socket.destroy()
    if (Date.now() > deadline) {
      fail('the network policy of this pod is not enforced, it still reaches ' + nameserver)
    }
    setTimeout(attempt, 500)
  })
  // dropped or refused: the policy holds
  socket.once('timeout', () => process.exit(0))
  socket.once('error', () => process.exit(0))
}
attempt()
`

export const HELPER_SECURITY_CONTEXT: V1SecurityContext = {
  runAsNonRoot: true,
  // the image's `node` user
  runAsUser: 1000,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
}

// What the gate of a pod with an open network waits to no longer reach: an address
// (and port) the policy of its namespace denies, answered without the policy.
export interface NetworkGateTarget {
  host: string
  port: number
}

// how long the gate of an open pod waits for an answer of its target: a link-local
// address answers at once, when it is reached at all
const OPEN_GATE_PROBE_MS = 1000

// `target`: the address of an open pod's gate (getOpenNetworkGate); without it, the
// cluster DNS a limited pod is denied
export function getNetworkGateContainer(target?: NetworkGateTarget): V1Container {
  return {
    name: NETWORK_GATE_CONTAINER,
    image: EGRESS_PROXY_IMAGE,
    command: ['node', '-e', NETWORK_GATE_SCRIPT],
    ...(target
      ? {
          env: [
            { name: 'HAMMERKIT_GATE_HOST', value: target.host },
            { name: 'HAMMERKIT_GATE_PORT', value: `${target.port}` },
            { name: 'HAMMERKIT_GATE_PROBE_MS', value: `${OPEN_GATE_PROBE_MS}` },
            {
              name: 'HAMMERKIT_GATE_HINT',
              value:
                `the server's ${OPEN_NETWORK_GATE_SETTING} points this wait at another address ` +
                'the namespace denies, or turns it off with false',
            },
          ],
        }
      : {}),
    securityContext: HELPER_SECURITY_CONTEXT,
    resources: { limits: { memory: '64Mi' } },
  }
}

// The metadata endpoint of the clouds, which hands out the node's identity
export const METADATA_ADDRESS = '169.254.169.254'

// the setting of the server that turns the gate of open pods off or points it elsewhere
export const OPEN_NETWORK_GATE_SETTING = 'backend.openNetworkGate'

/**
 * The gate of the pods with an open network on a server: they wait until they no longer
 * reach an address the policy of their namespace denies them, by default the metadata
 * endpoint (`backend.deniedEgress` covers it). The operator points it elsewhere, or turns
 * it off with `false` (`backend.openNetworkGate`). None when the operator did not state that
 * the cluster enforces NetworkPolicy, or when the address isn't denied or is allowed: the
 * gate would never open.
 */
export function getOpenNetworkGate(backend: {
  networkPolicy?: 'enforced'
  deniedEgress: string[]
  allowedEgress: string[]
  openNetworkGate?: false | NetworkGateTarget
}): NetworkGateTarget | undefined {
  if (backend.networkPolicy !== 'enforced' || backend.openNetworkGate === false) {
    return undefined
  }
  const target = backend.openNetworkGate ?? { host: METADATA_ADDRESS, port: 80 }
  const covers = (ranges: string[]) => {
    const list = new BlockList()
    for (const range of ranges) {
      const [address, prefix] = range.split('/')
      if (isIPv4(address)) {
        list.addSubnet(address, prefix === undefined ? 32 : parseInt(prefix, 10), 'ipv4')
      }
    }
    return list.check(target.host, 'ipv4')
  }
  if (!covers(backend.deniedEgress) || covers(backend.allowedEgress)) {
    return undefined
  }
  return target
}
