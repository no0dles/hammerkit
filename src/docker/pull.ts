import Dockerode from 'dockerode'
import consola from 'consola'

export async function pull(docker: Dockerode, imageName: string): Promise<void> {
  let searchImageName = imageName
  if (imageName.indexOf(':') === -1) {
    searchImageName += ':latest'
  }
  const images = await docker.listImages({})
  if (images.some((i) => i.RepoTags?.some((repoTag) => repoTag === searchImageName))) {
    return
  }

  consola.debug(`pull image ${imageName}`)
  const image = await docker.pull(imageName)
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(image, (err: any, res: any) => (err ? reject(err) : resolve(res)))
  })
}
