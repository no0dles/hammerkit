export interface WorkPort {
  // 0 for any free port, which the running service reports in `published`
  hostPort: number | null
  containerPort: number
  // the address of the host the port is published on, all of them when left out
  hostIp?: string
}
