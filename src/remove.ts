import rimraf from 'rimraf';

export async function remove(directory: string) {
  return new Promise<void>((resolve, reject) => {
    rimraf(directory, err => {
      if(err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}
