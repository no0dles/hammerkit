import { rmdir } from 'fs'

export async function remove(directory: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    rmdir(directory, { recursive: true }, (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}
