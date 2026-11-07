// How CPU and memory read, for the dashboard and the CLI (without the clients of capacity.ts).

// cores as a person reads them: 0.25, 1.5, 12
export function formatCpu(cores: number | undefined): string {
  if (cores === undefined) {
    return '?'
  }
  if (cores === 0) {
    return '0'
  }
  return cores < 10 ? String(Math.round(cores * 100) / 100) : String(Math.round(cores * 10) / 10)
}

// bytes as a person reads them: 512 MiB, 3.4 GiB
export function formatMemory(bytes: number | undefined): string {
  if (bytes === undefined) {
    return '?'
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? Math.round(value * 10) / 10 : Math.round(value)} ${units[unit]}`
}
