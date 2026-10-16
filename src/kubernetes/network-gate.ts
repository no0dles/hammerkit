import { V1Container, V1SecurityContext } from '@kubernetes/client-node'
import { EGRESS_PROXY_IMAGE } from '../network/egress-proxy'

// Some network plugins (kind's kindnet among them) enforce a NetworkPolicy a
// moment after a pod started, so a limited pod's first connections could
// still get out. The gate is the pod's first init container: it waits until
// the pod no longer reaches the cluster DNS, which the policy of every limited
// item denies, so the item's own containers start only once the policy holds.
// A policy that never takes hold fails the pod instead of running it open.
// A script for `node -e` in the proxy's image, like the proxy.
export const NETWORK_GATE_TIMEOUT_MS = 60000

// Kept free of anything but Node's own modules.
export const NETWORK_GATE_SCRIPT = `
const fs = require('fs')
const net = require('net')
const resolvConf = process.env.HAMMERKIT_GATE_RESOLV_CONF || '/etc/resolv.conf'
const port = parseInt(process.env.HAMMERKIT_GATE_PORT || '53', 10)
const deadline = Date.now() + parseInt(process.env.HAMMERKIT_GATE_TIMEOUT_MS || '${NETWORK_GATE_TIMEOUT_MS}', 10)
function fail(message) {
  process.stderr.write('hammerkit: ' + message + '\\n')
  try {
    fs.writeFileSync('/dev/termination-log', 'hammerkit: ' + message)
  } catch (e) {}
  process.exit(1)
}
let conf = ''
try {
  conf = fs.readFileSync(resolvConf, 'utf8')
} catch (e) {}
const match = /^nameserver\\s+(\\S+)/m.exec(conf)
if (!match) {
  fail('the pod has no cluster DNS, so its network policy can not be checked')
}
const nameserver = match[1]
function attempt() {
  const socket = net.connect({ host: nameserver, port, timeout: 2000 })
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

export function getNetworkGateContainer(): V1Container {
  return {
    name: 'hammerkit-network',
    image: EGRESS_PROXY_IMAGE,
    command: ['node', '-e', NETWORK_GATE_SCRIPT],
    securityContext: HELPER_SECURITY_CONTEXT,
    resources: { limits: { memory: '64Mi' } },
  }
}
