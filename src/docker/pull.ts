import { StatusScopedConsole } from '../planner/work-node-status'
import { Environment } from '../executer/environment'

export async function pull(status: StatusScopedConsole, environment: Environment, imageName: string): Promise<void> {
  let searchImageName = imageName
  if (imageName.indexOf(':') === -1) {
    searchImageName += ':latest'
  }
  const images = await environment.docker.listImages({})
  if (images.some((i) => i.RepoTags?.some((repoTag) => repoTag === searchImageName))) {
    return
  }

  status.write('debug', `pull image ${imageName}`)
  const image = await environment.docker.pull(imageName)
  await new Promise<void>((resolve, reject) => {
    environment.docker.modem.followProgress(image, (err: any, res: any) => (err ? reject(err) : resolve(res)))
  })
}
