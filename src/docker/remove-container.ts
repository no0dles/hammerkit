import { Container } from 'dockerode'
import { sleep } from '../utils/sleep'

export async function removeContainer(container: Container): Promise<void> {
  try {
    await container.remove({ force: true })
  } catch (e: any) {
    if (e.statusCode === 404) {
      return
    } else if (e.statusCode === 409) {
      await sleep(500)
      return removeContainer(container)
    }
    throw e
  }
}
