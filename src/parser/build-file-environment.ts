export interface BuildFileEnvironment {
  namespace: string
  context: string
  ingresses: BuildFileEnvironmentIngress[]
}

export interface BuildFileEnvironmentIngress {
  host: string
  service: string
  servicePort: number
  path: string
}
