import { existsSync } from 'fs'
import { remove } from './remove'
import consola from 'consola'
import { copy } from './copy'

export async function moveFiles(folder: () => Generator<{ from: string; to: string }>): Promise<void> {
  const foldersToCopy: { from: string; to: string }[] = []

  const addFolder = (from: string, to: string) => {
    if (!existsSync(from)) {
      return
    }

    if (foldersToCopy.some((f) => f.from === from && f.to === to)) {
      return
    }

    foldersToCopy.push({ from, to })
  }

  for (const { from, to } of folder()) {
    addFolder(from, to)
  }

  for (const folder of foldersToCopy) {
    if (existsSync(folder.to)) {
      await remove(folder.to)
    }

    consola.debug(`copy ${folder.from} to ${folder.to}`)
    copy(folder.from, folder.to)
  }
}
