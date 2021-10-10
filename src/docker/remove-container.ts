import { Container } from 'dockerode'

export async function removeContainer(container: Container) {
  try {
    await container.remove({ force: true })
  } catch (e: any) {
    if (e.statusCode === 404) {
      return
    } else if (e.statusCode === 409) {
      return
    }
    throw e
  }
}
