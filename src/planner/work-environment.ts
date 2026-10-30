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
  // what the claim of a task or service requests when it states no `volumeSize`
  // (DEFAULT_VOLUME_SIZE when left out), and at most (a server's `maxVolumeSize`)
  volumeSize?: string
  maxVolumeSize?: string
  // the cluster enforces NetworkPolicy, as the build file states
  networkPolicyEnforced: boolean
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
  // the image each secret provider's command runs in, and the hosts it reaches through
  // the egress proxy of a task with a limited network
  providers: { [provider: string]: { image: string; allow?: string[] } }
  // what the commands of an account's secrets get in the Job
  accounts: { [account: string]: { serviceAccount?: string; audience?: string; secret?: string } }
  // set when the run works on a sandbox: its files are a claim the tasks mount
  workspace?: WorkKubernetesWorkspace
  // set when the claims of tasks stay after the run (`backend.keepVolumes`): the trust of
  // the run's source, which a kept claim is named and labelled by, so only a run of the
  // same source mounts it again
  volumeScope?: string
  // the RuntimeClass of a sandbox (`backend.capabilities.runtimeClass`), which the pod of a
  // task that adds capabilities runs in; such a task is refused without it, and with
  // `unavailable`: why the run's namespace can't admit it
  capabilities?: { runtimeClass: string; unavailable?: string }
}

// The claim of a sandbox in place of the run's directory `root`: a source or mount below
// `root` is mounted from the claim, from the same path below `subPath`, so what a task
// writes there lands in the sandbox. The pods that mount it carry `label` and keep to the
// node of each other (a claim of one node at a time).
export interface WorkKubernetesWorkspace {
  root: string
  claim: string
  subPath: string
  label: string
  // the pod of the sandbox's files the run holds: what stays with the sandbox for its
  // next runs (the egress proxy of a task, its runner) goes with this pod
  pod?: { name: string; uid: string }
  // set when commands of a task shaped like a shell are exec'd into the sandbox's runner
  // (`backend.sandboxes.runner`, see sandbox-runner.ts)
  runner?: true
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
