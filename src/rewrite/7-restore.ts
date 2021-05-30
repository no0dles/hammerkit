import { join, relative } from 'path'
import { existsSync } from 'fs'
import { copy } from '../file/copy'
import { nodes } from './1-plan'
import { ExecutionBuildFile } from './0-parse'
import consola from 'consola'
import { remove } from '../file/remove'

export async function restore(buildFile: ExecutionBuildFile, targetDirectory: string): Promise<void> {
  const tree = nodes(buildFile)

  await moveFiles(function* () {
    for (const key of Object.keys(tree)) {
      const node = tree[key]

      const cacheDir = join(node.path, '.hammerkit')
      const sourceCacheDir = join(targetDirectory, relative(buildFile.path, node.path), '.hammerkit')

      yield { from: sourceCacheDir, to: cacheDir }

      for (const targetPath of node.generates) {
        const sourcePath = join(targetDirectory, relative(buildFile.path, targetPath))
        yield { from: sourcePath, to: targetPath }
      }
    }
  })
}

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
