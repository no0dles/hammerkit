import { Environment } from '../executer/environment'
import { WorkItem } from '../planner/work-item'

export async function moveFiles(
  item: WorkItem<any>,
  context: Environment,
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

    item.status.write('debug', `copy ${folder.from} to ${folder.to}`)
    await context.file.copy(folder.from, folder.to)
  }
}
