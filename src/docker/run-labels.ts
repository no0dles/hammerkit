import { hostname } from 'os'

// Which hammerkit process on which machine started a container. `clean` uses
// them to tell a container a killed run left behind from one still in use.
export function getRunLabels(): { [key: string]: string } {
  return {
    'hammerkit-pid': process.pid.toString(),
    'hammerkit-host': hostname(),
  }
}
