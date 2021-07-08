import { WorkNode } from '../planner/work-node'
import { Context } from '../run-arg'

export async function moveFiles(
  node: WorkNode,
  context: Context,
  folder: () => Generator<{ from: string; to: string }>
): Promise<void> {
  const foldersToCopy: { from: string; to: string }[] = []

  const addFolder = async (from: string, to: string) => {
    if (!(await context.file.exists(from))) {
      return
    }

    if (foldersToCopy.some((f) => f.from === from && f.to === to)) {
      return
    }

    foldersToCopy.push({ from, to })
  }

  for (const { from, to } of folder()) {
    await addFolder(from, to)
  }

  for (const folder of foldersToCopy) {
    if (await context.file.exists(folder.to)) {
      await context.file.remove(folder.to)
    }

    node.status.console.write('internal', 'debug', `copy ${folder.from} to ${folder.to}`)
    await context.file.copy(folder.from, folder.to)
  }
}
