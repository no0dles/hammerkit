import { join } from 'path'
import { homedir } from 'os'

export function getDefaultKubeConfig(): string {
  return join(homedir(), '.kube/config')
}
