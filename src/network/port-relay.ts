// The published ports of a service with a limited network. Docker publishes
// ports only on a network with a way out, which a limited service must not
// have, so a relay container on the default bridge publishes them and passes
// each connection on to the service over the service's internal network.
// Like the egress proxy, it is a script for `node -e` in a stock Node image.

export interface PortRelayTarget {
  // the port the relay listens on and publishes
  port: number
  // where it passes a connection on to
  host: string
  targetPort: number
}

// Kept free of anything but Node's own modules.
export const PORT_RELAY_SCRIPT = `
const net = require('net')
const targets = JSON.parse(process.env.HAMMERKIT_RELAY || '[]')
for (const target of targets) {
  // a client that ends its side still gets the answer
  net
    .createServer({ allowHalfOpen: true }, (client) => {
      const upstream = net.connect(target.targetPort, target.host)
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
    })
    .listen(target.port)
}
process.on('SIGTERM', () => process.exit(0))
`

export function getPortRelayCommand(): string[] {
  return ['node', '-e', PORT_RELAY_SCRIPT]
}

export function getPortRelayEnvironment(targets: PortRelayTarget[]): { [key: string]: string } {
  return { HAMMERKIT_RELAY: JSON.stringify(targets) }
}
