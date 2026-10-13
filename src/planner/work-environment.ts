import { BuildFileEnvironmentSchemaHttpRoute } from '../schema/build-file-environment-schema-http-route'

export type WorkEnvironment = WorkKubernetesEnvironment | WorkDockerEnvironment

export interface WorkDockerEnvironment {
  type: 'docker'
  host?: string
}

export interface WorkKubernetesEnvironment {
  type: 'kubernetes'
  namespace: string
  kubeConfig?: string
  // the context of the kubeconfig; its current one when left out (on a server, the
  // cluster it runs in)
  context?: string
  httpRoutes: BuildFileEnvironmentSchemaHttpRoute[]
  storageClass?: string
  // set when a hammerkit server runs the tasks of a run on its cluster
  server?: WorkKubernetesServer
}

// What the operator of a server decided for the Jobs of a run, in place of what a
// build file's environment would say (see specs/remote-compute).
export interface WorkKubernetesServer {
  // the run: a label on what is made for it
  run: string
  // the server's own namespace, where the credentials of the accounts are
  namespace: string
  // the first is where container tasks go; a local task runs in the toolImage of
  // the pool that offers its platform
  pools: WorkKubernetesPool[]
  // the image each secret provider's command runs in
  providers: { [provider: string]: { image: string } }
  // what the commands of an account's secrets get in the Job
  accounts: { [account: string]: { serviceAccount?: string; audience?: string; secret?: string } }
}

export interface WorkKubernetesPool {
  name: string
  platform: { os: 'linux'; arch: 'amd64' | 'arm64' }
  nodeSelector: { [label: string]: string }
  tolerations: {
    key?: string
    operator?: string
    value?: string
    effect?: string
    tolerationSeconds?: number
  }[]
  toolImage?: string
}
