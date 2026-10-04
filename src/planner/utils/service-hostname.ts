// A DNS label from the service name: Docker writes the container's hostname
// into its own /etc/hosts, so the service reaches itself by name (a database
// that advertises its own address, such as a MongoDB replica set member).
export function getServiceHostname(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 63) || 'service'
  )
}
