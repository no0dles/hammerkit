import dockerode from 'dockerode'
import consola from 'consola'
import { parseEnvs } from './env'

export class RunArg {
  constructor(
    public disableCache: boolean,
    public workers: number,
    public docker = new dockerode({}),
    public logger = consola,
    public envs = parseEnvs(),
    private paths: { id: string; name: string }[] = []
  ) {}

  getPath(name: string): string {
    return [...this.paths.map((p) => p.name), name].join(' -> ')
  }

  hasParent(id: string): boolean {
    return this.paths.some((p) => p.id === id)
  }

  child(id: string, name: string): RunArg {
    return new RunArg(this.disableCache, this.workers, this.docker, this.logger, this.envs, [
      ...this.paths,
      {
        id,
        name,
      },
    ])
  }
}
