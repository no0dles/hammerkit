import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { FileContext } from '../file/file-context'
import { ConsoleContext } from '../console/console-context'
import { StatusConsole } from '../planner/work-item-status'
import { Writable } from 'stream'
import { SecretRegistry } from '../utils/redact'
import type { SecretCatalog } from '../secrets/secret-catalog'

// How a hammerkit server runs the engine for somebody else's build file. Its
// secret providers and accounts are the operator's, never the build file's, and
// the project's `.env` files are not read.
export interface HostedPolicy {
  catalog: SecretCatalog
  // the accounts the run may read secrets as; a secret of any other is refused when
  // it is fetched, whatever the plan said
  accounts?: string[]
  // where container tasks and services run: the cluster of the server's Kubernetes
  // backend, in place of the build file's environment
  kubernetes?: WorkKubernetesEnvironment
  // a local task runs in a container (a pool's tool image on the server's cluster), so
  // its `network` can be limited; set where the build file is read without `kubernetes`
  localTasksInContainers?: boolean
}

export interface Environment {
  processEnvs: { [key: string]: string | undefined }
  abortCtrl: AbortController
  cwd: string
  file: FileContext
  console: ConsoleContext
  status: StatusConsole
  stdout: Writable
  stderr: Writable
  stdoutColumns: number
  // the secret values this run has read, masked in all it logs
  secrets: SecretRegistry
  // set on a server, see HostedPolicy
  hosted?: HostedPolicy
}
